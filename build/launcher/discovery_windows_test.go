package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixtureExe(t *testing.T, file string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}
func TestCodexDiscovery(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", root)
	t.Setenv("PATH", root)
	t.Setenv("ARM_CODEX_EXE", "")
	if _, err := discoverCodex(); err == nil {
		t.Fatal("missing CLI accepted")
	}
	older := fixtureExe(t, filepath.Join(root, "OpenAI/Codex/bin/old/codex.exe"))
	oldTime := time.Now().Add(-time.Hour)
	os.Chtimes(older, oldTime, oldTime)
	newest := fixtureExe(t, filepath.Join(root, "OpenAI/Codex/bin/new/codex.exe"))
	if got, err := discoverCodex(); err != nil || got != newest {
		t.Fatalf("newest discovery: %s %v", got, err)
	}
	onPath := fixtureExe(t, filepath.Join(root, "codex.exe"))
	if got, err := discoverCodex(); err != nil || got != onPath {
		t.Fatalf("PATH priority: %s %v", got, err)
	}
	t.Setenv("ARM_CODEX_EXE", older)
	if got, err := discoverCodex(); err != nil || got != older {
		t.Fatalf("explicit priority: %s %v", got, err)
	}
	t.Setenv("ARM_CODEX_EXE", filepath.Join(root, "absent.exe"))
	if _, err := discoverCodex(); err == nil {
		t.Fatal("invalid override accepted")
	}
}
func TestChromeDiscovery(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", root)
	t.Setenv("ProgramFiles", root)
	t.Setenv("ProgramFiles(x86)", root)
	t.Setenv("ARM_CHROME_EXE", "")
	if _, err := discoverChrome(); err == nil {
		t.Fatal("missing Chrome accepted")
	}
	file := fixtureExe(t, filepath.Join(root, "Google/Chrome/Application/chrome.exe"))
	if got, err := discoverChrome(); err != nil || got != file {
		t.Fatalf("Chrome discovery: %s %v", got, err)
	}
}
