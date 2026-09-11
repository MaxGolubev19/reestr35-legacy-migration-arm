# АРМ захвата legacy-страниц Реестра 35

Локальное приложение принимает URL вида `https://<company>.reestr35.ru/`, снимает содержательные сегменты страницы в PNG и проводит потоковую визуальную QA-проверку. Исполняемый backend, helper `capture.cjs` и QA-конфигурация находятся в `src/`; интерфейс — в `public/`, тесты — в `test/`. Исходный skill и прежний workspace не нужны.

## Быстрый запуск

Требуются:

- Windows и PowerShell;
- Node.js 20+;
- Chrome;
- доступные Node-модули `playwright` и `sharp`;
- `codex.exe` и выполненный вход в Codex.

Из корня `reestr35-legacy-migration-arm`:

```powershell
./start.ps1
```

Затем откройте <http://127.0.0.1:4318>.

Пример с другим портом, лимитом параллельности и внешним каталогом данных:

```powershell
./start.ps1 -Port 4319 -Concurrency 1 -DataDir 'D:\Reestr35\arm-data'
```

`start.ps1` предпочтителен: он находит bundled Node Codex и его модули, проверяет зависимости и сохраняет журнал backend в `<ARM_DATA_DIR>/logs/`, создавая этот каталог при необходимости. `npm start` и `node src/server.cjs` тоже поддерживаются, если Node-окружение уже настроено. Все варианты запуска работают из произвольного текущего каталога: пути приложения вычисляются от корня АРМа, а не от `process.cwd()`.

### Параметры

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `ARM_DATA_DIR` | `local/` | Корень локальных данных; относительный путь считается от корня АРМа |
| `ARM_PORT` | `4318` | Локальный HTTP-порт |
| `ARM_CONCURRENCY` | `2` | Общий лимит capture и QA, от 1 до 8 |
| `ARM_CODEX_EXE` | `codex` | Путь к Codex CLI |
| `ARM_IDLE_TIMEOUT_MS` | `600000` | Таймаут простоя после готового capture/manifest |

Если в `state.json` уже сохранена concurrency, она имеет приоритет над стартовым fallback. Изменить лимит во время работы можно в интерфейсе или через `POST /api/settings` с JSON `{ "concurrency": 1 }`.

## Локальные данные

При первом запуске АРМ сам создаёт `local/`. Если каталога нет, очередь стартует с чистым состоянием. Каталог исключён из Git через `.gitignore`.

```text
local/
├─ state.json                 # очередь, попытки, статусы и concurrency
├─ server.lock                # защита от второго backend
├─ runs/                     # capture, manifests, QA-checkpoints и итоги
├─ logs/
│  └─ server-*.log           # журналы start.ps1
├─ qa-staging/               # проверенные копии PNG для QA
├─ qa-servers/               # рабочие cwd app-server
├─ tmp/                      # временные файлы Node/Playwright
├─ test-output/              # артефакты тестов
└─ test-temp/                # временные тестовые каталоги
```

Каждая попытка хранится в `local/runs/<job-id>/attempt-NNN/`. Старые попытки не перезаписываются. JSON состояния, manifest, QA-progress и результата записываются атомарно через временный файл и rename. Повреждённый `state.json` не сбрасывается молча.

## Как работает попытка

1. Backend нормализует URL и ставит capture в FIFO-очередь.
2. Trusted `src/launcher.cjs` один раз запускает локальный `src/capture.cjs` без shell.
3. Backend проверяет `capture-report.json` и все PNG, затем фиксирует immutable `capture-manifest.json` с размерами и SHA-256.
4. Для QA-прохода компании создаётся отдельный одноразовый `codex app-server`.
5. Все ещё не проверенные PNG передаются в одном ephemeral turn. Единственный QA-инструмент `record_review` принимает результат по одному PNG.
6. Каждый принятый вызов сразу сохраняет checkpoint в `qa-progress.json`; после сбоя проверяется только остаток.
7. Итог вычисляет backend по manifest и checkpoints. Текстовый ответ модели сам по себе не подтверждает QA.

Галерея показывает только PNG из capture report. Перед QA и каждым checkpoint backend повторно проверяет manifest, пути, PNG signature/IHDR, размеры и SHA-256. Копии для QA стейджатся внутри каталога данных и сверяются по SHA-256.

## Статусы

| Статус | Значение |
| --- | --- |
| `queued` / `paused` | Capture ждёт запуска / поставлен на паузу |
| `running` / `validating` | Идёт capture или QA / backend вычисляет результат |
| `complete` | Capture полон, manifest цел, все обязательные PNG приняты как `passed` |
| `needs_review` | Capture полон, но остались непроверенные PNG |
| `incomplete` | Capture неполон, артефакты изменены или QA нашёл дефект |
| `failed` | Инфраструктурная ошибка без готового capture/report |
| `stopping` / `cancelled` | Остановка / отмена пользователем |
| `interrupted` | Попытка была активна во время перезапуска backend |

## Параллельность, остановка и восстановление

Общий лимит concurrency учитывает и capture, и QA. Каждый QA-проход занимает один слот до фактического закрытия его app-server. Повышение лимита сразу запускает следующие FIFO-задания; понижение не прерывает уже активные.

Закрытие браузера не останавливает backend. `Ctrl+C` останавливает активные задания, закрывает app-server и сохраняет очередь. Остановка одной компании не затрагивает другие.

Для capture и QA сохраняются launch token, generation, PID и lease. После restart backend не завершает чужой или неопределённый PID. Восстановление разрешается только по finished lease или после консервативной проверки смерти всех связанных процессов. Поздние события прежнего generation игнорируются.

После сбоя QA АРМ до трёх раз автоматически повторяет только непроверенный остаток. Отмена пользователем запрещает автопродолжение. Capture автоматически не перезапускается.

## Изоляция QA

QA запускается на `gpt-5.6-sol` с reasoning `medium` и читает только проверенные копии PNG. В его контексте нет project instructions, skills, memories, hooks, plugins, collaboration, shell, browser/computer tools, apps и image generation. Доступен только `record_review`; sandbox read-only, approval policy `never`.

Пользовательские MCP отключаются по имени после `config/read`: пустое `mcp_servers={}` не очищает объединённый конфиг. Реальный wire audit проверяет итоговый payload CLI: ровно один tool, никаких проектных инструкций и `detail: original` для PNG. После обновления Codex CLI этот audit нужно повторить.

## Безопасность и интерфейс

- Backend слушает только `127.0.0.1` и проверяет Host, Origin, CSRF и `sec-fetch-site`.
- Допускаются только HTTPS-адреса `*.reestr35.ru` без credentials и нестандартного порта; redirect обязан сохранить origin.
- File API отдаёт только PNG/report из manifest и фиксированные журналы, проверяя realpath против symlink/junction.
- Браузер не задаёт команды, модель, аргументы или пути.
- UI использует локальные vendor-файлы Tabler, CSP и `textContent`. Источники, хэши и лицензии лежат в `public/vendor/UPSTREAM.md`, `LICENSE` и `ICONS-LICENSE`.

Интерфейс показывает очередь, историю попыток, галерею, счётчики QA и журналы. SSE обновляет состояние сразу, polling остаётся fallback. Полные журналы хранятся на диске; UI показывает хвост до 128 KiB.

## Тесты

Полный набор:

```powershell
npm test
```

Целевые наборы:

| Команда | Что проверяет |
| --- | --- |
| `npm run test:backend` | Очередь, manifest, checkpoints, stop/recovery и API |
| `npm run test:ui` | Интерфейс и браузерные сценарии |
| `npm run test:capture` | Самостоятельный capture helper |
| `npm run test:portability` | `local/`, `ARM_DATA_DIR`, чужая cwd и перенос данных |
| `npm run test:cli` | Wire audit установленного Codex CLI |

Все npm test-команды идут через `test/run.cjs`. Runner находит Node с нужными модулями и до старта test workers направляет `TMP`, `TEMP` и `TMPDIR` в `<ARM_DATA_DIR>/tmp`. Тесты не меняют рабочие `runs`, `state.json` и `server.lock`.

Wire audit использует локальный mock `/responses`, не вызывает реальную модель и не запускает инструменты:

```powershell
$env:ARM_TEST_CODEX_EXE = (Get-Command codex).Source
npm run test:cli
```

Без `ARM_TEST_CODEX_EXE` wire audit пропускается.
