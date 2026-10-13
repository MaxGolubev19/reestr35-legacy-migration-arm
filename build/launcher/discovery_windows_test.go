package main

import (
	"os"
	"path/filepath"
	"testing"
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
func TestZcodeDiscovery(t *testing.T) {
	root := t.TempDir()
	t.Setenv("ProgramFiles", root)
	t.Setenv("ProgramFiles(x86)", root)
	t.Setenv("ARM_ZCODE_CJS", "")
	if _, err := discoverZcode(); err == nil {
		t.Fatal("missing CLI accepted")
	}
	file := fixtureExe(t, filepath.Join(root, "ZCode/resources/glm/zcode.cjs"))
	if got, err := discoverZcode(); err != nil || got != file {
		t.Fatalf("Program Files discovery: %s %v", got, err)
	}
	t.Setenv("ARM_ZCODE_CJS", file)
	if got, err := discoverZcode(); err != nil || got != file {
		t.Fatalf("explicit priority: %s %v", got, err)
	}
	t.Setenv("ARM_ZCODE_CJS", filepath.Join(root, "absent.cjs"))
	if _, err := discoverZcode(); err == nil {
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
