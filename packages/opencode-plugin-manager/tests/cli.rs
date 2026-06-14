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

// ---------------------------------------------------------------------------
// Output mode guarantees
// ---------------------------------------------------------------------------

#[test]
fn test_quiet_list_produces_no_stdout() {
    let content = r#"{"plugin": ["my-plugin"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--quiet", "list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout is not valid UTF-8");
    assert!(
        stdout.is_empty(),
        "--quiet list should produce no stdout, got: {stdout:?}"
    );
}

#[test]
fn test_quiet_outdated_produces_no_stdout() {
    let content = r#"{"plugin": []}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--quiet", "outdated", "--project"])
        .output()
        .expect("execute oc-plugins");
    // Empty plugin list exits success with no stdout in quiet mode
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout is not valid UTF-8");
    assert!(
        stdout.is_empty(),
        "--quiet outdated should produce no stdout, got: {stdout:?}"
    );
}

#[test]
fn test_quiet_outdated_suppresses_human_output_when_classified() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();

    // Config with a plugin that has an installed manifest
    let config = r#"{"plugin": ["my-plugin@1.0.0"]}"#;
    std::fs::write(root.join("opencode.json"), config).expect("write config");

    // Create installed manifest in the XDG cache path expected by
    // ProjectDirs::from("", "", "opencode").cache_dir()
    let xdg_cache = root.join("xdg-cache");
    let manifest_dir = xdg_cache.join("opencode/packages/my-plugin@1.0.0/node_modules/my-plugin");
    std::fs::create_dir_all(&manifest_dir).expect("create manifest dir");
    std::fs::write(
        manifest_dir.join("package.json"),
        r#"{"name":"my-plugin","version":"1.0.0"}"#,
    )
    .expect("write manifest");

    // Create notice cache in the XDG cache path expected by
    // ProjectDirs::from("", "", "oc-plugins").cache_dir()
    let oc_plugins_cache = xdg_cache.join("oc-plugins");
    std::fs::create_dir_all(&oc_plugins_cache).expect("create cache dir");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let cache = serde_json::json!({
        "checked_at": now,
        "notices": [
            {
                "package_name": "my-plugin",
                "latest_version": "2.0.0",
                "installed_version": "1.0.0"
            }
        ]
    });
    std::fs::write(
        oc_plugins_cache.join("notice.json"),
        serde_json::to_string(&cache).unwrap(),
    )
    .expect("write notice cache");

    // Run --quiet outdated with XDG_CACHE_HOME pointing into our temp dir
    let output = oc_plugins(root)
        .env("XDG_CACHE_HOME", &xdg_cache)
        .args(["--quiet", "outdated", "--project"])
        .output()
        .expect("execute oc-plugins");

    // Exit code should be 1 because my-plugin@1.0.0 < latest 2.0.0
    assert!(
        !output.status.success(),
        "expected exit code 1 for outdated plugins, got: {}",
        output.status
    );
    assert_eq!(output.status.code(), Some(1));

    // Stdout must be empty — --quiet suppresses all human output
    let stdout = String::from_utf8(output.stdout).expect("stdout is not valid UTF-8");
    assert!(
        stdout.is_empty(),
        "--quiet outdated must suppress all stdout when plugins are classified, got: {stdout:?}"
    );
}

#[test]
fn test_json_list_output_is_single_json_object() {
    let content = r#"{"plugin": ["@scope/pkg@1.0.0"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--json", "list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    let trimmed = stdout.trim();
    // Must start with { and end with } — no preamble, no trailer
    assert!(
        trimmed.starts_with('{') && trimmed.ends_with('}'),
        "JSON output must be a single object, got: {trimmed:?}"
    );
    // Must parse as valid JSON
    let parsed: serde_json::Value = serde_json::from_str(trimmed).expect("must parse as JSON");
    assert!(parsed.get("plugins").is_some());
}

#[test]
fn test_human_list_output_has_header() {
    let content = r#"{"plugin": ["my-plugin"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    assert!(
        stdout.contains("Configured OpenCode plugins"),
        "human list should contain header"
    );
}

#[test]
fn test_human_list_empty_shows_no_plugins() {
    let content = r#"{"plugin": []}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    assert!(
        stdout.contains("No configured plugins found"),
        "empty list should show no-plugins message"
    );
}

#[test]
fn test_json_error_shape_for_not_found() {
    let content = r#"{"plugin": ["existing"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--json", "remove", "nonexistent", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("error output must be JSON");
    assert_eq!(parsed["error"], "NOT_FOUND");
    assert!(
        parsed["message"].is_string(),
        "error JSON must have a message string"
    );
}

#[test]
fn test_human_list_verbose_shows_config_path() {
    let content = r#"{"plugin": ["my-plugin"]}"#;
    let (dir, config_path) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--verbose", "list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    // Verbose mode should show config path
    assert!(
        stdout.contains(&config_path.display().to_string()),
        "verbose list should show config path, got: {stdout:?}"
    );
}

#[test]
fn test_human_list_nonverbose_hides_config_path() {
    let content = r#"{"plugin": ["my-plugin"]}"#;
    let (dir, config_path) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    assert!(
        !stdout.contains(&config_path.display().to_string()),
        "non-verbose list should not show config path, got: {stdout:?}"
    );
}

#[test]
fn test_human_add_dry_run_shows_preview() {
    let content = r#"{"plugin": ["existing"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["add", "new-plugin", "--project", "--dry-run", "--yes"])
        .output()
        .expect("execute oc-plugins");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    // Human dry-run must contain actual dry-run/preview wording, not merely the plugin name.
    // The add command prints "Config change preview" header and "[dry-run] no changes applied"
    // in dry-run human mode.
    assert!(
        stdout.contains("[dry-run]"),
        "human dry-run must contain '[dry-run]' indicator, got: {stdout:?}"
    );
    assert!(
        stdout.contains("Config change preview"),
        "human dry-run must contain 'Config change preview' header, got: {stdout:?}"
    );
}

#[test]
fn test_human_remove_not_found_shows_error() {
    let content = r#"{"plugin": ["existing"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["remove", "nonexistent", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(!output.status.success(), "remove nonexistent should fail");
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    let stderr = String::from_utf8(output.stderr).expect("valid UTF-8");
    let combined = format!("{stdout}{stderr}");
    assert!(
        combined.contains("nonexistent")
            || combined.contains("not found")
            || combined.contains("NOT_FOUND"),
        "error should mention the missing plugin, got: {combined:?}"
    );
}

#[test]
fn test_human_add_duplicate_shows_error() {
    let content = r#"{"plugin": ["my-plugin"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["add", "my-plugin", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(!output.status.success(), "add duplicate should fail");
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    let stderr = String::from_utf8(output.stderr).expect("valid UTF-8");
    let combined = format!("{stdout}{stderr}");
    assert!(
        combined.contains("my-plugin")
            || combined.contains("already")
            || combined.contains("duplicate"),
        "error should mention the duplicate, got: {combined:?}"
    );
}

#[test]
fn test_json_outdated_empty_produces_valid_shape() {
    let content = r#"{"plugin": []}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--json", "outdated", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "outdated with no plugins should succeed"
    );
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("must be valid JSON");
    // Should have the three arrays
    assert!(
        parsed.get("outdated").is_some(),
        "must have 'outdated' array"
    );
    assert!(parsed.get("current").is_some(), "must have 'current' array");
    assert!(
        parsed.get("unresolved").is_some(),
        "must have 'unresolved' array"
    );
}

// ---------------------------------------------------------------------------
// Combo flag tests (JSON + quiet/verbose precedence)
// ---------------------------------------------------------------------------

#[test]
fn test_json_takes_precedence_over_quiet_list() {
    let content = r#"{"plugin": ["@scope/pkg@1.0.0"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--quiet", "--json", "list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    assert!(
        !stdout.is_empty(),
        "--quiet should NOT suppress JSON output; stdout was empty"
    );
    let trimmed = stdout.trim();
    assert!(
        trimmed.starts_with('{'),
        "JSON output must start with '{{', got: {trimmed:?}"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(trimmed).expect("must parse as valid JSON");
    assert!(
        parsed.get("plugins").is_some(),
        "JSON must contain 'plugins' field"
    );
}

#[test]
fn test_json_takes_precedence_over_quiet_outdated() {
    let content = r#"{"plugin": []}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--quiet", "--json", "outdated", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    assert!(
        !stdout.is_empty(),
        "--quiet should NOT suppress JSON output for outdated"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("must be valid JSON");
    assert!(
        parsed.get("outdated").is_some(),
        "must have 'outdated' array"
    );
    assert!(parsed.get("current").is_some(), "must have 'current' array");
    assert!(
        parsed.get("unresolved").is_some(),
        "must have 'unresolved' array"
    );
}

#[test]
fn test_json_verbose_list_produces_single_json_object() {
    let content = r#"{"plugin": ["@scope/pkg@1.0.0"]}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--json", "--verbose", "list", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    let trimmed = stdout.trim();
    assert!(
        trimmed.starts_with('{'),
        "JSON + verbose list output must start with '{{', no human preamble allowed; got: {trimmed:?}"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(trimmed).expect("must parse as valid JSON");
    assert!(
        parsed.get("plugins").is_some(),
        "JSON output must contain 'plugins' field"
    );
}

#[test]
fn test_json_verbose_outdated_produces_valid_shape() {
    let content = r#"{"plugin": []}"#;
    let (dir, _) = with_config(content);
    let root = dir.path();

    let output = oc_plugins(root)
        .args(["--json", "--verbose", "outdated", "--project"])
        .output()
        .expect("execute oc-plugins");
    assert!(
        output.status.success(),
        "expected success, got status: {}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).expect("valid UTF-8");
    assert!(
        !stdout.is_empty(),
        "JSON verbose outdated should produce output"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(stdout.trim()).expect("must be valid JSON");
    assert!(
        parsed.get("outdated").is_some(),
        "must have 'outdated' array"
    );
    assert!(parsed.get("current").is_some(), "must have 'current' array");
    assert!(
        parsed.get("unresolved").is_some(),
        "must have 'unresolved' array"
    );
}
