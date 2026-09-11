package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var kernel = syscall.NewLazyDLL("kernel32.dll")
var client = &http.Client{Timeout: time.Second}

type endpoint struct {
	URL      string
	Instance string
}

func utf16(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func ready(e endpoint) bool {
	if !strings.HasPrefix(e.URL, "http://127.0.0.1:") || e.Instance == "" {
		return false
	}
	r, err := client.Get(e.URL + "/api/health")
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var state struct {
		App      string
		Instance string
	}
	return r.StatusCode == 200 && json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&state) == nil && state.App == "Reestr35 ARM" && state.Instance == e.Instance
}
func openBrowser(url string) error {
	if os.Getenv("ARM_NO_BROWSER") == "1" {
		return nil
	}
	result, _, _ := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(utf16("open"))), uintptr(unsafe.Pointer(utf16(url))), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("cannot open default browser (%d): %s", result, url)
	}
	return nil
}
func executableFile(file string) bool {
	info, err := os.Stat(file)
	return err == nil && info.Mode().IsRegular() && strings.EqualFold(filepath.Ext(file), ".exe")
}
func discoverCodex() (string, error) {
	if explicit := os.Getenv("ARM_CODEX_EXE"); explicit != "" {
		resolved, err := exec.LookPath(explicit)
		if err == nil && executableFile(resolved) {
			return filepath.Abs(resolved)
		}
		return "", fmt.Errorf("ARM_CODEX_EXE does not point to an existing codex.exe: %s", explicit)
	}
	if found, err := exec.LookPath("codex.exe"); err == nil && executableFile(found) {
		return filepath.Abs(found)
	}
	files, _ := filepath.Glob(filepath.Join(os.Getenv("LOCALAPPDATA"), "OpenAI", "Codex", "bin", "*", "codex.exe"))
	candidates := files[:0]
	for _, file := range files {
		if executableFile(file) {
			candidates = append(candidates, file)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, _ := os.Stat(candidates[i])
		b, _ := os.Stat(candidates[j])
		if a.ModTime().Equal(b.ModTime()) {
			return candidates[i] < candidates[j]
		}
		return a.ModTime().After(b.ModTime())
	})
	if len(candidates) > 0 {
		return candidates[0], nil
	}
	return "", fmt.Errorf("Codex CLI was not found. Install Codex, sign in, or set ARM_CODEX_EXE to the full path of codex.exe")
}
func discoverChrome() (string, error) {
	if explicit := os.Getenv("ARM_CHROME_EXE"); explicit != "" {
		if filepath.IsAbs(explicit) && executableFile(explicit) {
			return explicit, nil
		}
		return "", fmt.Errorf("ARM_CHROME_EXE does not point to an existing Chrome executable: %s", explicit)
	}
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
		if base == "" {
			continue
		}
		file := filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe")
		if executableFile(file) {
			return file, nil
		}
	}
	return "", fmt.Errorf("Google Chrome was not found. Install Chrome before starting Reestr35 ARM")
}
func run(root string, log *os.File) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	app := filepath.Dir(exe)
	sum := sha256.Sum256([]byte(strings.ToLower(root)))
	mutex, _, callErr := kernel.NewProc("CreateMutexW").Call(0, 0, uintptr(unsafe.Pointer(utf16("Local\\Reestr35ARM-"+hex.EncodeToString(sum[:16])))))
	if mutex == 0 {
		return fmt.Errorf("create application mutex: %v", callErr)
	}
	defer syscall.CloseHandle(syscall.Handle(mutex))
	statePath := filepath.Join(root, "launcher.json")
	if callErr == syscall.Errno(183) {
		for deadline := time.Now().Add(40 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			data, _ := os.ReadFile(statePath)
			var e endpoint
			if json.Unmarshal(data, &e) == nil && ready(e) {
				return openBrowser(e.URL)
			}
		}
		return fmt.Errorf("ARM is already starting or stopping. See logs in %s", root)
	}
	codex, err := discoverCodex()
	if err != nil {
		return err
	}
	chrome, err := discoverChrome()
	if err != nil {
		return err
	}
	fmt.Fprintf(log, "Codex CLI: %s\nChrome: %s\n", codex, chrome)
	port := 4318
	if value := os.Getenv("ARM_PORT"); value != "" {
		port, err = strconv.Atoi(value)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("invalid ARM_PORT")
		}
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		return err
	}
	e := endpoint{fmt.Sprintf("http://127.0.0.1:%d", port), hex.EncodeToString(token)}
	runtime := filepath.Join(app, "runtime")
	for _, file := range []string{"node.exe", "node_modules/playwright/package.json", "node_modules/sharp/package.json"} {
		if _, err = os.Stat(filepath.Join(runtime, file)); err != nil {
			return fmt.Errorf("incomplete ARM package: %w", err)
		}
	}
	cmd := exec.Command(filepath.Join(runtime, "node.exe"), filepath.Join(app, "src", "server.cjs"))
	cmd.Dir = app
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	// Remove inherited Node injection, and make package resolution explicit.
	for _, item := range os.Environ() {
		name := strings.ToUpper(strings.SplitN(item, "=", 2)[0])
		if name != "NODE_PATH" && name != "NODE_OPTIONS" && name != "ARM_RUNTIME_DIR" && name != "ARM_DATA_DIR" && name != "ARM_INSTANCE_ID" && name != "ARM_CODEX_EXE" && name != "ARM_CHROME_EXE" {
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "NODE_PATH="+filepath.Join(runtime, "node_modules"), "ARM_RUNTIME_DIR="+runtime, "ARM_DATA_DIR="+root, "ARM_INSTANCE_ID="+e.Instance, "ARM_CODEX_EXE="+codex, "ARM_CHROME_EXE="+chrome)
	if err = cmd.Start(); err != nil {
		return err
	}
	fmt.Fprintf(log, "Backend PID %d; %s\n", cmd.Process.Pid, e.URL)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	started := false
	for deadline := time.Now().Add(40 * time.Second); time.Now().Before(deadline); time.Sleep(150 * time.Millisecond) {
		select {
		case err = <-done:
			return fmt.Errorf("backend exited before readiness: %v", err)
		default:
		}
		if ready(e) {
			started = true
			break
		}
	}
	if !started {
		_ = cmd.Process.Kill()
		<-done
		return fmt.Errorf("backend readiness timeout; see %s", log.Name())
	}
	data, _ := json.Marshal(e)
	if err = os.WriteFile(statePath, data, 0600); err != nil {
		_ = cmd.Process.Kill()
		<-done
		return err
	}
	defer os.Remove(statePath)
	if err = openBrowser(e.URL); err != nil {
		fmt.Fprintln(log, err)
		showError(err, log.Name())
	}
	// Keep the launcher alive until the UI shutdown has finished cleaning workers.
	if err = <-done; err != nil {
		return fmt.Errorf("backend stopped unexpectedly: %w", err)
	}
	return nil
}
func showError(err error, logPath string) {
	if os.Getenv("ARM_NO_BROWSER") == "1" {
		return
	}
	text := fmt.Sprintf("%v\n\nLog: %s", err, logPath)
	syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(utf16(text))), uintptr(unsafe.Pointer(utf16("Reestr35 ARM"))), 0x10)
}
func main() {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		showError(fmt.Errorf("LOCALAPPDATA is unavailable"), "")
		os.Exit(1)
	}
	root := filepath.Join(base, "Reestr35 ARM")
	logs := filepath.Join(root, "logs")
	if err := os.MkdirAll(logs, 0700); err != nil {
		showError(err, logs)
		os.Exit(1)
	}
	logPath := filepath.Join(logs, fmt.Sprintf("launcher-%s-%d.log", time.Now().Format("20060102-150405.000"), os.Getpid()))
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		showError(err, logPath)
		os.Exit(1)
	}
	err = run(root, log)
	if err != nil {
		fmt.Fprintln(log, err)
	}
	log.Close()
	if err != nil {
		showError(err, logPath)
		os.Exit(1)
	}
}
