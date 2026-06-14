use crate::errors::CliError;
use jsonc_parser::parse_to_ast;
use std::fs;
use std::path::{Path, PathBuf};

/// Modification to apply to the plugin array in a config file.
pub enum PluginArrayModification {
    /// Add a new spec. Fails if already present.
    Add(String),
    /// Remove a spec by package name. Fails if not found.
    Remove(String),
    /// Replace a spec. Fails if old not found.
    Update { old: String, new: String },
}

/// Read a config file, returning its content as a string.
pub fn read_config(path: &Path) -> Result<String, CliError> {
    fs::read_to_string(path).map_err(|e| CliError::Io {
        path: path.display().to_string(),
        source: e,
    })
}

/// Patch the "plugin" array in a JSONC config string and return the modified content.
///
/// The original content is preserved except for the plugin array contents.
/// If the "plugin" key does not exist, it is created at the top level.
///
/// JSONC comments and trailing commas inside the plugin array are accepted:
/// the array is parsed with `jsonc-parser` and serialised back as
/// pretty-printed JSON.  This means the in-array formatting is normalised,
/// but valid JSONC input never fails solely because the array has comments
/// or trailing commas.
pub fn patch_plugin_array(
    content: &str,
    modification: PluginArrayModification,
) -> Result<String, CliError> {
    // Handle empty config: create a new one with just the plugin array
    let content = if content.trim().is_empty() {
        match modification {
            PluginArrayModification::Add(ref spec) => {
                return Ok(format!(
                    "{{\n  \"plugin\": [\"{}\"]\n}}\n",
                    serde_json::to_string(spec)
                        .map_err(|e| CliError::Parse {
                            detail: e.to_string()
                        })?
                        .trim_matches('"')
                ));
            }
            _ => {
                return Err(CliError::Config(
                    "config file is empty and cannot perform this operation".into(),
                ));
            }
        }
    } else {
        content
    };

    if let Some((array_start, array_end)) = find_plugin_array_bounds(content) {
        patch_existing_array(content, array_start, array_end, modification)
    } else {
        // No "plugin" key found — try to insert one
        insert_plugin_key(content, modification)
    }
}

/// Append a suffix to a file path without replacing the existing extension.
/// For `opencode.jsonc` with suffix `".bak"`, produces `opencode.jsonc.bak`.
fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Return a unique temp file path alongside `path` by incorporating the
/// process ID.  This avoids races when concurrent processes write to the
/// same config file.
fn unique_temp_path(path: &Path) -> PathBuf {
    let pid = std::process::id();
    append_suffix(path, &format!(".tmp.{}", pid))
}

/// Write content to a config file atomically via temp file + rename.
/// Creates a backup of the original if it exists.
///
/// The backup and temp-file suffixes preserve the original extension,
/// so a `.jsonc` file gets `.jsonc.bak` and `.jsonc.tmp` (instead of
/// losing the `.jsonc` suffix).
pub fn write_config(path: &Path, content: &str) -> Result<(), CliError> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| CliError::Io {
            path: parent.display().to_string(),
            source: e,
        })?;
    }

    // Create backup if the original exists (preserves extension: file.jsonc → file.jsonc.bak)
    let backup_path = append_suffix(path, ".bak");
    if path.exists() {
        fs::copy(path, &backup_path).map_err(|e| CliError::Io {
            path: path.display().to_string(),
            source: e,
        })?;
    }

    // Write to a unique temp file in the same directory (file.jsonc → file.jsonc.tmp.1234).
    // The PID suffix avoids races when concurrent processes write to the same path.
    let temp_path = unique_temp_path(path);
    fs::write(&temp_path, content).map_err(|e| CliError::Io {
        path: temp_path.display().to_string(),
        source: e,
    })?;

    // Atomic rename
    fs::rename(&temp_path, path).map_err(|e| {
        // Rollback: try to restore from backup
        let _ = fs::copy(&backup_path, path);
        let _ = fs::remove_file(&temp_path);
        CliError::Io {
            path: path.display().to_string(),
            source: e,
        }
    })?;

    // Clean up backup on success
    let _ = fs::remove_file(&backup_path);

    Ok(())
}

/// Generate a default config file content with the given plugin spec.
pub fn new_config_with_plugin(spec: &str) -> Result<String, CliError> {
    let spec_json = serde_json::to_string(spec).map_err(|e| CliError::Parse {
        detail: e.to_string(),
    })?;
    Ok(format!("{{\n  \"plugin\": [{}]\n}}\n", spec_json))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Find the byte range of the top-level "plugin" array in JSONC content.
///
/// Uses the `jsonc-parser` AST to locate the property, which handles
/// inline comments between the key and value (`"plugin" /* default */: [...]`),
/// trailing commas, and other JSONC constructs that a simple text scanner
/// would miss.
fn find_plugin_array_bounds(content: &str) -> Option<(usize, usize)> {
    // Primary path: use the JSONC AST (handles comments anywhere).
    if let Ok(ast) = parse_to_ast(content, &Default::default(), &Default::default())
        && let Some(jsonc_parser::ast::Value::Object(obj)) = ast.value.as_ref()
    {
        for prop in &obj.properties {
            if prop.name.as_str() == "plugin"
                && let jsonc_parser::ast::Value::Array(arr) = &prop.value
            {
                return Some((arr.range.start, arr.range.end));
            }
        }
    }

    // Fallback: text scanner for content the AST cannot parse (rare edge cases).
    let key = "\"plugin\"";
    let mut search_from = 0;

    while let Some(pos) = content[search_from..].find(key) {
        let abs_pos = search_from + pos;
        let after_key = &content[abs_pos + key.len()..];

        // Find the opening bracket (whitespace/colon between key and bracket allowed)
        if let Some(bracket_offset) = after_key.find('[') {
            let between = &after_key[..bracket_offset];
            let trimmed = between.trim();
            if trimmed.is_empty() || trimmed == ":" {
                let array_start = abs_pos + key.len() + bracket_offset;
                if let Some(array_text) = find_matching_bracket(&content[array_start..]) {
                    let array_end = array_start + array_text.len();
                    // Validate: the content between key and array must contain exactly one ':'
                    if content[abs_pos + key.len()..array_start].contains(':') {
                        return Some((array_start, array_end));
                    }
                }
            }
        }

        search_from = abs_pos + key.len();
    }

    None
}

/// Find the matching closing bracket for the opening bracket at position 0.
fn find_matching_bracket(content: &str) -> Option<&str> {
    let mut depth = 0;
    let mut in_string = false;
    let mut escape = false;

    for (i, c) in content.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if c == '\\' && in_string {
            escape = true;
            continue;
        }
        if c == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&content[..=i]);
                }
            }
            _ => {}
        }
    }

    None
}

/// Parse a JSONC array text into a `Vec<String>`, accepting comments and
/// trailing commas that `serde_json` would reject.
fn parse_plugin_array_jsonc(text: &str) -> Result<Vec<String>, CliError> {
    let ast = parse_to_ast(text, &Default::default(), &Default::default()).map_err(|e| {
        CliError::Parse {
            detail: format!("failed to parse plugin array: {e}"),
        }
    })?;

    if let Some(jsonc_parser::ast::Value::Array(arr)) = ast.value {
        let mut result = Vec::with_capacity(arr.elements.len());
        for element in &arr.elements {
            if let jsonc_parser::ast::Value::StringLit(s) = element {
                result.push(s.value.to_string());
            } else {
                return Err(CliError::Parse {
                    detail: "plugin array element is not a string".to_string(),
                });
            }
        }
        Ok(result)
    } else {
        Err(CliError::Parse {
            detail: "expected an array for 'plugin' key".to_string(),
        })
    }
}

/// Patch an existing plugin array in the content.
///
/// The array is parsed using `jsonc-parser` (JSONC-aware) so that comments
/// and trailing commas inside the plugin array are accepted.  The result is
/// serialised back as pretty-printed JSON, normalising in-array formatting.
fn patch_existing_array(
    content: &str,
    array_start: usize,
    array_end: usize,
    modification: PluginArrayModification,
) -> Result<String, CliError> {
    let array_text = &content[array_start..array_end];

    // Parse the array using JSONC-aware parser (accepts comments/trailing commas)
    let array = parse_plugin_array_jsonc(array_text)?;

    let new_array = match modification {
        PluginArrayModification::Add(spec) => {
            let pkg_name = crate::safety::package_name_from_spec(&spec);
            if array
                .iter()
                .any(|s| crate::safety::package_name_from_spec(s) == pkg_name)
            {
                return Err(CliError::Validation(format!(
                    "plugin '{spec}' is already configured"
                )));
            }
            let mut arr = array;
            arr.push(spec);
            arr
        }
        PluginArrayModification::Remove(spec) => {
            let pkg_name = crate::safety::package_name_from_spec(&spec);
            let mut arr = array;
            let before_len = arr.len();
            arr.retain(|s| crate::safety::package_name_from_spec(s) != pkg_name);
            if arr.len() == before_len {
                return Err(CliError::NotFound(format!(
                    "plugin '{spec}' not found in config"
                )));
            }
            arr
        }
        PluginArrayModification::Update { old, new } => {
            let old_pkg = crate::safety::package_name_from_spec(&old);
            let mut arr = array;
            let found = arr
                .iter_mut()
                .find(|s| crate::safety::package_name_from_spec(s) == old_pkg);
            match found {
                Some(entry) => {
                    *entry = new;
                }
                None => {
                    return Err(CliError::NotFound(format!(
                        "plugin '{old}' not found in config"
                    )));
                }
            }
            arr
        }
    };

    // Serialize the new array
    let new_array_text = serde_json::to_string_pretty(&new_array).map_err(|e| CliError::Parse {
        detail: format!("failed to serialize plugin array: {e}"),
    })?;

    // Build the result by replacing the array text
    let mut result = String::with_capacity(content.len() + new_array_text.len());
    result.push_str(&content[..array_start]);
    result.push_str(&new_array_text);
    result.push_str(&content[array_end..]);

    // Validate the result parses correctly
    validate_jsonc(&result)?;

    Ok(result)
}

/// Insert a new "plugin" key into the root object.
///
/// The root object's closing brace is located using the `jsonc-parser` AST,
/// so nested objects (`{"other": {"nested": true}}`) don't confuse the
/// insertion point.
fn insert_plugin_key(
    content: &str,
    modification: PluginArrayModification,
) -> Result<String, CliError> {
    let spec = match modification {
        PluginArrayModification::Add(spec) => spec,
        _ => {
            return Err(CliError::Config(
                "cannot perform this operation: no 'plugin' key in config".into(),
            ));
        }
    };

    // Parse the content as JSONC to find the root object's closing brace range.
    // The CST feature provides range information on AST nodes.
    let ast = parse_to_ast(content, &Default::default(), &Default::default()).map_err(|e| {
        CliError::Parse {
            detail: format!("failed to parse config: {e}"),
        }
    })?;

    let close_brace = ast
        .value
        .as_ref()
        .and_then(|v| {
            if let jsonc_parser::ast::Value::Object(obj) = v {
                // range.end is the position after the closing '}' — we want
                // the position *of* the '}' itself, so subtract 1.
                Some(obj.range.end.saturating_sub(1))
            } else {
                None
            }
        })
        .ok_or_else(|| CliError::Parse {
            detail: "no root object found in config".to_string(),
        })?;

    let spec_json = serde_json::to_string(&spec).map_err(|e| CliError::Parse {
        detail: e.to_string(),
    })?;

    let mut result = String::with_capacity(content.len() + 64);
    // Everything before the root closing '}'
    result.push_str(&content[..close_brace]);

    // Add comma if the existing content doesn't end with a comma or opening brace
    let trimmed = result.trim_end();
    if !trimmed.ends_with('{') && !trimmed.ends_with(',') {
        result.push(',');
    }
    result.push('\n');
    result.push_str("  \"plugin\": [");
    result.push_str(&spec_json);
    result.push_str("]\n");

    // The closing '}' and everything after it
    result.push_str(&content[close_brace..]);

    validate_jsonc(&result)?;

    Ok(result)
}

/// Validate that content is valid JSONC.
fn validate_jsonc(content: &str) -> Result<(), CliError> {
    let _ = parse_to_ast(content, &Default::default(), &Default::default()).map_err(|e| {
        CliError::Parse {
            detail: format!("modified config is invalid JSONC: {e}"),
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn find_matching_bracket_simple() {
        let result = find_matching_bracket(r#"["a", "b"]"#);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), r#"["a", "b"]"#);
    }

    #[test]
    fn find_matching_bracket_nested_strings() {
        let result = find_matching_bracket(r#"["a\"b", "c"]"#);
        assert!(result.is_some());
        assert_eq!(result.unwrap(), r#"["a\"b", "c"]"#);
    }

    #[test]
    fn find_plugin_array_bounds_basic() {
        let content = r#"{
  "plugin": ["a", "b"]
}"#;
        let bounds = find_plugin_array_bounds(content);
        assert!(bounds.is_some());
        let (start, end) = bounds.unwrap();
        assert_eq!(&content[start..end], r#"["a", "b"]"#);
    }

    #[test]
    fn find_plugin_array_bounds_multiline() {
        let content = r#"{
  "plugin": [
    "a",
    "b"
  ]
}"#;
        let bounds = find_plugin_array_bounds(content);
        assert!(bounds.is_some());
        let (start, end) = bounds.unwrap();
        let array = &content[start..end];
        assert!(array.starts_with('['));
        assert!(array.ends_with(']'));
    }

    #[test]
    fn find_plugin_array_bounds_no_plugin_key() {
        let content = r#"{
  "other": "value"
}"#;
        assert!(find_plugin_array_bounds(content).is_none());
    }

    #[test]
    fn patch_add_to_existing_array() {
        let content = r#"{
  "plugin": ["existing"]
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("new-plugin".into())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].as_str().unwrap(), "existing");
        assert_eq!(plugins[1].as_str().unwrap(), "new-plugin");
    }

    #[test]
    fn patch_add_duplicate_fails() {
        let content = r#"{
  "plugin": ["my-plugin"]
}"#;
        let result = patch_plugin_array(content, PluginArrayModification::Add("my-plugin".into()));
        assert!(result.is_err());
    }

    #[test]
    fn patch_remove_from_array() {
        let content = r#"{
  "plugin": ["keep", "remove-me", "also-keep"]
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Remove("remove-me".into()))
                .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].as_str().unwrap(), "keep");
        assert_eq!(plugins[1].as_str().unwrap(), "also-keep");
    }

    #[test]
    fn patch_remove_not_found_fails() {
        let content = r#"{
  "plugin": ["existing"]
}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Remove("nonexistent".into()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn patch_update_in_array() {
        let content = r#"{
  "plugin": ["old-plugin@1.0.0"]
}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "old-plugin@1.0.0".into(),
                new: "old-plugin@latest".into(),
            },
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "old-plugin@latest");
    }

    #[test]
    fn patch_insert_plugin_key_when_missing() {
        let content = r#"{
  "other": "value"
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("new-plugin".into())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "new-plugin");
    }

    #[test]
    fn patch_empty_content_adds_plugin() {
        let result =
            patch_plugin_array("", PluginArrayModification::Add("new-plugin".into())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
    }

    #[test]
    fn atomic_write_creates_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test-config.json");

        write_config(&path, r#"{"plugin": ["test"]}"#).unwrap();

        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("test"));
    }

    #[test]
    fn atomic_write_creates_backup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test-config.json");

        // Write initial content
        fs::write(&path, r#"{"plugin": ["old"]}"#).unwrap();

        // Write new content
        write_config(&path, r#"{"plugin": ["new"]}"#).unwrap();

        // Backup should be cleaned up on success
        let backup = append_suffix(&path, ".bak");
        assert!(!backup.exists());

        // File should have new content
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("new"));
    }

    #[test]
    fn atomic_write_preserves_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");

        let original = r#"{
  // my config
  "plugin": ["a"]
}
"#;
        write_config(&path, original).unwrap();
        let read_back = fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, original);
    }

    #[test]
    fn new_config_with_plugin_format() {
        let content = new_config_with_plugin("my-plugin").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "my-plugin");
    }

    #[test]
    fn patch_remove_by_package_name_resolves_version() {
        let content = r#"{
  "plugin": ["@scope/pkg@1.0.0", "other"]
}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Remove("@scope/pkg".into()),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "other");
    }

    #[test]
    fn patch_update_not_found_returns_error() {
        let content = r#"{"plugin": ["existing"]}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "nonexistent".into(),
                new: "replacement".into(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn patch_remove_from_empty_plugin_array_fails() {
        let content = r#"{"plugin": []}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Remove("anything".into()));
        assert!(result.is_err());
    }

    #[test]
    fn patch_add_to_empty_plugin_array() {
        let content = r#"{"plugin": []}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("new-plugin".into())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "new-plugin");
    }

    #[test]
    fn patch_add_preserves_jsonc_comments() {
        let content = r#"{
  // my config
  "plugin": ["existing"],
  "other": true
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("new-plugin".into())).unwrap();
        assert!(result.contains("// my config"));
        assert!(result.contains("\"other\": true"));
        assert!(result.contains("\"existing\""));
        assert!(result.contains("\"new-plugin\""));
    }

    #[test]
    fn patch_complex_jsonc_with_multiline_comments() {
        let content = r#"{
  // OpenCode configuration
  "model": "anthropic/claude-sonnet-4-6",
  "plugin": [
    "opencode-gemini-auth@1.0.0",
    "opencode-ram-monitor@latest"
  ],
  // MCP settings
  "mcp": {}
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("new-plugin".into())).unwrap();
        assert!(result.contains("// OpenCode configuration"));
        assert!(result.contains("// MCP settings"));
        assert!(result.contains("\"model\""));
        assert!(result.contains("\"mcp\""));
        assert!(result.contains("\"opencode-ram-monitor@latest\""));
        assert!(result.contains("\"new-plugin\""));
    }

    #[test]
    fn atomic_write_creates_backup_before_overwrite() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, r#"{"plugin": ["original"]}"#).unwrap();

        write_config(&path, r#"{"plugin": ["updated"]}"#).unwrap();

        // Backup should be cleaned up on success
        let backup = append_suffix(&path, ".bak");
        assert!(
            !backup.exists(),
            "backup should be cleaned up after successful write"
        );
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("updated"));
    }

    #[test]
    fn atomic_write_new_file_no_backup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new-config.json");

        write_config(&path, r#"{"plugin": ["test"]}"#).unwrap();

        let backup = append_suffix(&path, ".bak");
        assert!(!backup.exists(), "no backup should exist for new file");
        assert!(path.exists());
    }

    #[test]
    fn atomic_write_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("config.json");

        write_config(&path, r#"{"plugin": ["test"]}"#).unwrap();

        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("test"));
    }

    #[test]
    fn new_config_with_plugin_produces_valid_jsonc() {
        let content = new_config_with_plugin("@scope/pkg").unwrap();
        // Should be valid JSONC (parseable)
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["plugin"][0].as_str().unwrap(), "@scope/pkg");
        // Should contain the key structure
        assert!(content.contains("\"plugin\""));
    }

    #[test]
    fn patch_add_when_only_model_key_exists() {
        let content = r#"{"model": "anthropic/claude-sonnet-4-6"}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("new-plugin".into())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(
            parsed["model"].as_str().unwrap(),
            "anthropic/claude-sonnet-4-6"
        );
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "new-plugin");
    }

    #[test]
    fn read_config_reads_file_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let expected = r#"{"plugin": ["test"]}"#;
        fs::write(&path, expected).unwrap();

        let content = read_config(&path).unwrap();
        assert_eq!(content, expected);
    }

    #[test]
    fn read_config_returns_error_for_missing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nonexistent.json");
        let result = read_config(&path);
        assert!(result.is_err());
    }

    #[test]
    fn patch_add_preserves_many_existing_plugins() {
        let content = r#"{"plugin": ["p1", "p2", "p3", "p4", "p5"]}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("p6".into())).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 6);
        assert_eq!(plugins[5].as_str().unwrap(), "p6");
        // All originals preserved
        for i in 0..5 {
            assert_eq!(plugins[i].as_str().unwrap(), format!("p{}", i + 1));
        }
    }

    #[test]
    fn patch_update_preserves_other_plugins() {
        let content = r#"{"plugin": ["a", "b@1.0.0", "c"]}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "b@1.0.0".into(),
                new: "b@2.0.0".into(),
            },
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 3);
        assert_eq!(plugins[0].as_str().unwrap(), "a");
        assert_eq!(plugins[1].as_str().unwrap(), "b@2.0.0");
        assert_eq!(plugins[2].as_str().unwrap(), "c");
    }

    #[test]
    fn write_and_read_config_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = r#"{
  // my config
  "plugin": ["a", "b"]
}
"#;
        write_config(&path, original).unwrap();
        let read_back = read_config(&path).unwrap();
        assert_eq!(read_back, original);
    }

    // --- JSONC-aware array parsing ---

    #[test]
    fn patch_array_with_comments() {
        let content = r#"{
  "plugin": [
    // first plugin
    "alpha",
    // second plugin
    "beta"
  ]
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("gamma".into())).unwrap();
        // In-array comments are normalised (per documented behaviour), but
        // the operation succeeds and the new plugin is correctly added.
        assert!(result.contains("\"gamma\""));
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 3);
        assert_eq!(plugins[0].as_str().unwrap(), "alpha");
        assert_eq!(plugins[1].as_str().unwrap(), "beta");
        assert_eq!(plugins[2].as_str().unwrap(), "gamma");
    }

    #[test]
    fn patch_array_with_trailing_commas() {
        let content = r#"{
  "plugin": [
    "alpha",
    "beta",
  ],
  "other": true
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Add("gamma".into())).unwrap();
        // Result should parse as valid JSON (array formatted as pretty JSON)
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 3);
        assert_eq!(plugins[0].as_str().unwrap(), "alpha");
        assert_eq!(plugins[1].as_str().unwrap(), "beta");
        assert_eq!(plugins[2].as_str().unwrap(), "gamma");
        // Other keys preserved
        assert_eq!(parsed["other"].as_bool(), Some(true));
    }

    #[test]
    fn patch_array_with_comments_and_trailing_commas_remove() {
        let content = r#"{
  // config header
  "plugin": [
    // keep this
    "keep-me",
    // remove this
    "remove-me",
    /* also keep */
    "also-keep",
  ],
  "other": 42
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Remove("remove-me".into()))
                .unwrap();
        // Outside-comments preserved (above the "plugin" key).
        assert!(result.contains("// config header"));
        // In-array comments are normalised, but the result is correct.
        // Parse as JSONC (result has top-level comments).
        let ast = parse_to_ast(&result, &Default::default(), &Default::default()).unwrap();
        let obj = ast
            .value
            .as_ref()
            .and_then(|v| {
                if let jsonc_parser::ast::Value::Object(o) = v {
                    Some(o)
                } else {
                    None
                }
            })
            .unwrap();
        let plugin_prop = obj
            .properties
            .iter()
            .find(|p| p.name.as_str() == "plugin")
            .unwrap();
        let arr = if let jsonc_parser::ast::Value::Array(a) = &plugin_prop.value {
            a
        } else {
            panic!("not array")
        };
        let values: Vec<&str> = arr
            .elements
            .iter()
            .filter_map(|e| {
                if let jsonc_parser::ast::Value::StringLit(s) = e {
                    Some(s.value.as_ref())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], "keep-me");
        assert_eq!(values[1], "also-keep");
    }

    #[test]
    fn patch_array_with_comments_update() {
        let content = r#"{
  "plugin": [
    // pinned version
    "@scope/pkg@1.0.0",
    "other",
  ]
}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "@scope/pkg@1.0.0".into(),
                new: "@scope/pkg@latest".into(),
            },
        )
        .unwrap();
        // In-array comments are normalised, but the update is correct.
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].as_str().unwrap(), "@scope/pkg@latest");
        assert_eq!(plugins[1].as_str().unwrap(), "other");
    }

    #[test]
    fn parse_plugin_array_jsonc_empty() {
        let result = parse_plugin_array_jsonc("[]").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_plugin_array_jsonc_with_comments() {
        let result = parse_plugin_array_jsonc(
            r#"[
  // comment
  "alpha",
  /* block */ "beta",
]"#,
        )
        .unwrap();
        assert_eq!(result, vec!["alpha", "beta"]);
    }

    #[test]
    fn parse_plugin_array_jsonc_non_string_rejected() {
        let result = parse_plugin_array_jsonc(r#"["alpha", 42]"#);
        assert!(result.is_err());
    }

    // --- .jsonc extension preservation ---

    #[test]
    fn append_suffix_preserves_jsonc_extension() {
        let path = Path::new("opencode.jsonc");
        let bak = append_suffix(path, ".bak");
        assert_eq!(bak, PathBuf::from("opencode.jsonc.bak"));

        let tmp = append_suffix(path, ".tmp");
        assert_eq!(tmp, PathBuf::from("opencode.jsonc.tmp"));
    }

    #[test]
    fn append_suffix_works_for_json_too() {
        let path = Path::new("opencode.json");
        let bak = append_suffix(path, ".bak");
        assert_eq!(bak, PathBuf::from("opencode.json.bak"));

        let tmp = append_suffix(path, ".tmp");
        assert_eq!(tmp, PathBuf::from("opencode.json.tmp"));
    }

    #[test]
    fn atomic_write_preserves_jsonc_extension() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        fs::write(&path, r#"{"plugin": ["a"]}"#).unwrap();

        write_config(&path, r#"{"plugin": ["a", "b"]}"#).unwrap();

        // Main file still has .jsonc extension
        assert!(path.exists());
        assert_eq!(path.extension().unwrap(), "jsonc");

        // No stray .json file created
        let json_path = dir.path().join("opencode.json");
        assert!(!json_path.exists());
    }

    #[test]
    fn atomic_write_removes_jsonc_backup_on_success() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.jsonc");
        fs::write(&path, r#"{"plugin": ["old"]}"#).unwrap();

        write_config(&path, r#"{"plugin": ["new"]}"#).unwrap();

        // Backup cleaned up
        let backup = append_suffix(&path, ".bak");
        assert!(!backup.exists(), "backup should be cleaned up");
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("new"));
    }

    // --- Unique temp path ---

    #[test]
    fn unique_temp_path_uses_pid() {
        let path = Path::new("config.jsonc");
        let tmp = unique_temp_path(path);
        let name = tmp.file_name().unwrap().to_str().unwrap();
        // Should preserve .jsonc: "config.jsonc.tmp.<PID>"
        assert!(name.starts_with("config.jsonc.tmp."), "got: {name}");
        let pid_part = name.strip_prefix("config.jsonc.tmp.").unwrap();
        assert!(!pid_part.is_empty(), "PID suffix must not be empty");
        // PID should be numeric
        assert!(
            pid_part.chars().all(|c| c.is_ascii_digit()),
            "PID suffix should be numeric, got: {pid_part}"
        );
    }

    // --- Nested-object insert_plugin_key regression ---

    #[test]
    fn insert_plugin_key_with_nested_object() {
        // Root object has a nested object — rfind('}') would point to the
        // inner '}' instead of the root one.
        let content = r#"{
  "model": "claude",
  "other": {
    "nested": true
  }
}"#;
        let result =
            insert_plugin_key(content, PluginArrayModification::Add("my-plugin".into())).unwrap();
        // Validate the result parses as JSONC
        validate_jsonc(&result).unwrap();
        // Plugin key should be at the ROOT level, not inside the nested object
        let ast = parse_to_ast(&result, &Default::default(), &Default::default()).unwrap();
        let obj = ast
            .value
            .as_ref()
            .and_then(|v| {
                if let jsonc_parser::ast::Value::Object(o) = v {
                    Some(o)
                } else {
                    None
                }
            })
            .unwrap();
        let plugin_prop = obj.properties.iter().find(|p| p.name.as_str() == "plugin");
        assert!(
            plugin_prop.is_some(),
            "plugin key should exist at root level"
        );
        // The nested object should still exist
        let other_prop = obj.properties.iter().find(|p| p.name.as_str() == "other");
        assert!(other_prop.is_some(), "other key should still exist");
    }

    #[test]
    fn insert_plugin_key_with_deeply_nested_objects() {
        let content = r#"{
  "a": {"b": {"c": true}},
  "d": 1
}"#;
        let result =
            insert_plugin_key(content, PluginArrayModification::Add("pkg".into())).unwrap();
        validate_jsonc(&result).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["a"]["b"]["c"], true);
        assert_eq!(parsed["d"], 1);
        assert_eq!(parsed["plugin"][0], "pkg");
    }

    // --- Error-path tests for insert_plugin_key ---

    #[test]
    fn insert_plugin_key_non_object_root_rejected() {
        let content = r#"[1, 2, 3]"#;
        let result = insert_plugin_key(content, PluginArrayModification::Add("pkg".into()));
        assert!(result.is_err());
    }

    #[test]
    fn insert_plugin_key_add_only() {
        let content = r#"{"existing": true}"#;
        let result = insert_plugin_key(content, PluginArrayModification::Remove("pkg".into()));
        assert!(result.is_err());
    }

    // --- Inline comments between key and value ---

    #[test]
    fn find_array_with_inline_comment_after_key() {
        // The AST path handles this: "plugin" /* comment */: ["a"]
        let content = r#"{
  "plugin" /* default */: ["a"]
}"#;
        let (start, end) = find_plugin_array_bounds(content).unwrap();
        let array_text = &content[start..end];
        assert_eq!(array_text, r#"["a"]"#);
    }
    /// Parse the `"plugin"` array values from a JSONC object string (test helper).
    fn parse_plugins_from_jsonc_object(text: &str) -> Vec<String> {
        let ast = parse_to_ast(text, &Default::default(), &Default::default()).unwrap();
        let obj = ast
            .value
            .as_ref()
            .and_then(|v| {
                if let jsonc_parser::ast::Value::Object(o) = v {
                    Some(o)
                } else {
                    None
                }
            })
            .unwrap();
        let plugin_prop = obj
            .properties
            .iter()
            .find(|p| p.name.as_str() == "plugin")
            .unwrap();
        let arr = if let jsonc_parser::ast::Value::Array(a) = &plugin_prop.value {
            a
        } else {
            panic!("not an array")
        };
        arr.elements
            .iter()
            .filter_map(|e| {
                if let jsonc_parser::ast::Value::StringLit(s) = e {
                    Some(s.value.to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn patch_add_with_inline_comment_after_key() {
        let content = r#"{
  "model": "claude",
  "plugin" /* the list */: ["a"],
  "other": true
}"#;
        let result = patch_plugin_array(content, PluginArrayModification::Add("b".into())).unwrap();
        // Comment outside the array is preserved
        assert!(result.contains("/* the list */"));
        // Use JSONC-aware parse (result has top-level comments)
        validate_jsonc(&result).unwrap();
        let plugins = parse_plugins_from_jsonc_object(&result);
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0], "a");
        assert_eq!(plugins[1], "b");
    }

    #[test]
    fn patch_remove_with_block_comment_before_value() {
        let content = r#"{
  /* header */ "plugin" /* gap */ : /* x */ ["keep", "remove-me"],
  "other": 1
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Remove("remove-me".into()))
                .unwrap();
        assert!(result.contains("/* header */"));
        assert!(!result.contains("remove-me"));
        validate_jsonc(&result).unwrap();
        let plugins = parse_plugins_from_jsonc_object(&result);
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0], "keep");
    }

    #[test]
    fn patch_update_with_line_comment_after_key() {
        let content = r#"{
  "plugin" // version list
  : ["@scope/pkg@1.0.0"],
  "other": true
}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "@scope/pkg@1.0.0".into(),
                new: "@scope/pkg@latest".into(),
            },
        )
        .unwrap();
        assert!(result.contains("// version list"));
        validate_jsonc(&result).unwrap();
        let plugins = parse_plugins_from_jsonc_object(&result);
        assert_eq!(plugins[0], "@scope/pkg@latest");
    }

    #[test]
    fn find_array_multiple_plugin_keys_uses_first() {
        // If there are two "plugin" keys (unusual but possible in malformed config),
        // the AST picks the correct one (first declaration wins per JSON semantics).
        let content = r#"{
  "plugin": ["first"],
  "other": "value",
  "plugin": ["second"]
}"#;
        let (start, end) = find_plugin_array_bounds(content).unwrap();
        let array_text = &content[start..end];
        assert!(
            array_text.contains("first"),
            "should pick the first plugin array"
        );
    }
}
