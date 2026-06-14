//! End-to-end CLI smoke tests for the `oc-plugins` binary.
//!
//! These tests invoke the compiled binary with temp config fixtures and
//! verify JSON stdout contracts, dry-run no-write guarantees, and
//! exit codes.

use assert_cmd::Command;
use std::io::Write;
use std::path::PathBuf;

/// Assert that a `Command` output is a successful exit with valid JSON on stdout.
fn assert_ok_json(cmd: &mut Command) -> serde_json::Value {
    let output = cmd.output().expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout is not valid UTF-8");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout should be valid JSON");
    // Verify exactly one JSON document
    let trimmed = stdout.trim();
    assert!(
        trimmed.starts_with('{') && trimmed.ends_with('}'),
        "stdout must contain exactly one JSON object"
    );
    parsed
}

/// Assert that a `Command` output is a failure with valid JSON error on stdout.
fn assert_err_json(cmd: &mut Command) -> serde_json::Value {
    let output = cmd.output().expect("execute oc-plugins");
    assert!(!output.status.success(), "expected failure, got success");
    let stdout = String::from_utf8(output.stdout).expect("stdout is not valid UTF-8");
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout should be valid JSON (error case)");
    assert!(
        parsed.get("error").is_some(),
        "error JSON must contain 'error' field"
    );
    assert!(
        parsed.get("message").is_some(),
        "error JSON must contain 'message' field"
    );
    parsed
}

/// Create a temp directory with an opencode.json fixture. Returns (dir, config_path).
fn with_config(content: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = dir.path().join("opencode.json");
    let mut file = std::fs::File::create(&config_path).expect("create fixture");
    write!(file, "{content}").expect("write fixture");
    (dir, config_path)
}

/// Build a Command for oc-plugins, rooted at the given temp directory.
fn oc_plugins(root: &std::path::Path) -> Command {
    let mut cmd = Command::cargo_bin("oc-plugins").expect("find oc-plugins binary");
    cmd.current_dir(root);
    cmd
}

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

#[test]
fn test_json_list_empty_project() {
    let (dir, _) = with_config(r#"{"plugin": []}"#);
    let root = dir.path();

    let json = assert_ok_json(oc_plugins(root).args(["--json", "list", "--project"]));
    let plugins = json.get("plugins").and_then(|v| v.as_array()).unwrap();
    assert_eq!(
        plugins.len(),
        0,
        "empty config should produce empty plugin list"
    );
}

#[test]
fn test_json_list_with_plugins() {
    let content = r#"{"plugin": ["@scope/pkg@1.0.0", "simple-plugin@latest"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let json = assert_ok_json(oc_plugins(root).args(["--json", "list", "--project"]));
    let plugins = json.get("plugins").and_then(|v| v.as_array()).unwrap();
    assert_eq!(plugins.len(), 2, "should list 2 plugins");
    assert_eq!(plugins[0]["requestedSpec"], "@scope/pkg@1.0.0");
    assert_eq!(plugins[1]["requestedSpec"], "simple-plugin@latest");
}

#[test]
fn test_json_add_dry_run_does_not_write() {
    let content = r#"{"plugin": ["existing"]}"#;
    let (dir, config_path) = with_config(content);
    let root = dir.path();

    // Capture the file content before
    let before = std::fs::read_to_string(&config_path).ok();

    let json = assert_ok_json(oc_plugins(root).args([
        "--json",
        "add",
        "new-plugin",
        "--project",
        "--dry-run",
        "--yes",
    ]));
    assert_eq!(json["action"], "add");
    assert_eq!(json["dryRun"], true);

    // File should not have been modified
    let after = std::fs::read_to_string(&config_path).ok();
    assert_eq!(before, after, "dry-run should not modify the config file");
    assert!(
        !after.unwrap_or_default().contains("new-plugin"),
        "new plugin must NOT be written during dry-run"
    );
}

#[test]
fn test_json_remove_not_found_error() {
    let content = r#"{"plugin": ["existing"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let json =
        assert_err_json(oc_plugins(root).args(["--json", "remove", "nonexistent", "--project"]));
    assert_eq!(json["error"], "NOT_FOUND");
}

#[test]
fn test_json_add_duplicate_error() {
    let content = r#"{"plugin": ["my-plugin"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let json = assert_err_json(oc_plugins(root).args(["--json", "add", "my-plugin", "--project"]));
    assert_eq!(json["error"], "VALIDATION_ERROR");
}

#[test]
fn test_json_add_real_mode_writes_file() {
    let content = r#"{"plugin": ["existing"]}"#;
    let (dir, config_path) = with_config(content);
    let root = dir.path();

    // --yes skips the interactive prompt
    let mut cmd = oc_plugins(root);
    cmd.args(["--json", "add", "new-plugin", "--project", "--yes"]);

    let output = cmd.output().expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout is not valid UTF-8");
    let json: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout should be valid JSON");

    assert_eq!(json["action"], "add");
    assert_eq!(json["success"], true);
    assert_eq!(json["packageName"], "new-plugin");

    // Stdout must be exactly one JSON document (no preview before result)
    assert_eq!(
        stdout.trim().matches("success").count(),
        1,
        "'success' should appear exactly once (no preview+result split)"
    );

    // File should now contain the new plugin
    let content_after = std::fs::read_to_string(&config_path).unwrap();
    assert!(content_after.contains("new-plugin"), "file must be updated");
}
