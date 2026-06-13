use crate::config::provider::{ConfigProvider, ConfigScope, PluginEntry};
use crate::errors::CliError;
use directories::ProjectDirs;
use jsonc_parser::parse_to_ast;
use std::fs;
use std::path::{Path, PathBuf};

pub struct GlobalConfigProvider;

impl GlobalConfigProvider {
    pub fn new() -> Self {
        Self
    }
}

impl ConfigProvider for GlobalConfigProvider {
    fn scope(&self) -> ConfigScope {
        ConfigScope::Global
    }

    fn config_paths(&self) -> Result<Vec<PathBuf>, CliError> {
        let mut paths = Vec::new();
        if let Some(proj_dirs) = ProjectDirs::from("", "", "opencode") {
            let config_dir = proj_dirs.config_dir();
            paths.push(config_dir.join("opencode.jsonc"));
            paths.push(config_dir.join("opencode.json"));
            // Removed config.json
        }
        Ok(paths)
    }

    fn read_plugins(&self) -> Result<Vec<PluginEntry>, CliError> {
        let paths = self.config_paths()?;
        let mut plugins = Vec::new();

        for path in paths {
            if path.exists() {
                plugins.extend(extract_plugins_from_file(&path, ConfigScope::Global)?);
            }
        }

        Ok(plugins)
    }
}

pub struct ProjectConfigProvider {
    cwd: PathBuf,
}

impl ProjectConfigProvider {
    pub fn new(cwd: PathBuf) -> Self {
        Self { cwd }
    }
}

impl ConfigProvider for ProjectConfigProvider {
    fn scope(&self) -> ConfigScope {
        ConfigScope::Project
    }

    fn config_paths(&self) -> Result<Vec<PathBuf>, CliError> {
        let mut paths = Vec::new();

        let project_root = if self.cwd.ends_with(".opencode") {
            self.cwd.parent().unwrap_or(&self.cwd).to_path_buf()
        } else {
            self.cwd.clone()
        };

        let opencode_dir = project_root.join(".opencode");
        paths.push(opencode_dir.join("opencode.jsonc"));
        paths.push(opencode_dir.join("opencode.json"));
        paths.push(project_root.join("opencode.jsonc"));
        paths.push(project_root.join("opencode.json"));

        Ok(paths)
    }

    fn read_plugins(&self) -> Result<Vec<PluginEntry>, CliError> {
        let paths = self.config_paths()?;
        let mut plugins = Vec::new();

        for path in paths {
            if path.exists() {
                plugins.extend(extract_plugins_from_file(&path, ConfigScope::Project)?);
            }
        }

        Ok(plugins)
    }
}

fn extract_plugins_from_file(
    path: &Path,
    scope: ConfigScope,
) -> Result<Vec<PluginEntry>, CliError> {
    let content = fs::read_to_string(path).map_err(|e| CliError::Io {
        path: path.display().to_string(),
        source: e,
    })?;

    let ast = parse_to_ast(&content, &Default::default(), &Default::default()).map_err(|e| {
        CliError::Parse {
            detail: format!("Failed to parse {}: {}", path.display(), e),
        }
    })?;

    let mut plugins = Vec::new();

    if let Some(jsonc_parser::ast::Value::Object(obj)) = ast.value
        && let Some(plugin_prop) = obj.properties.iter().find(|p| p.name.as_str() == "plugin")
        && let jsonc_parser::ast::Value::Array(arr) = &plugin_prop.value
    {
        for element in &arr.elements {
            if let jsonc_parser::ast::Value::StringLit(s) = element
                && is_npm_spec(&s.value)
            {
                plugins.push(PluginEntry {
                    spec: s.value.to_string(),
                    scope: scope.clone(),
                    config_path: path.to_path_buf(),
                });
            }
        }
    }

    Ok(plugins)
}

fn is_npm_spec(spec: &str) -> bool {
    // Exclude explicitly local or protocol-based specs
    if spec.starts_with('.')
        || spec.starts_with('/')
        || spec.starts_with('~')
        || spec.contains("://")
        || spec.starts_with("file:")
        || spec.starts_with("github:")
        || spec.starts_with("git+")
        || spec.starts_with("bitbucket:")
    {
        return false;
    }

    // A simple validation for npm package names
    // Might optionally contain an @scope/ and an @version
    // Must start with an alphanumeric or @
    if !spec.starts_with('@')
        && !spec
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
    {
        return false;
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_npm_spec() {
        assert!(is_npm_spec("my-plugin"));
        assert!(is_npm_spec("@scope/plugin"));
        assert!(is_npm_spec("@scope/plugin@1.2.3"));
        assert!(is_npm_spec("plugin@latest"));

        assert!(!is_npm_spec("./local-plugin"));
        assert!(!is_npm_spec("../local-plugin"));
        assert!(!is_npm_spec("/absolute/path"));
        assert!(!is_npm_spec("file:../plugin"));
        assert!(!is_npm_spec("https://example.com/plugin.tgz"));
        assert!(!is_npm_spec("github:user/repo"));
    }

    #[test]
    fn test_extract_plugins() {
        use std::io::Write;
        use tempfile::NamedTempFile;

        let mut file = NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{
            "plugin": [
                "valid-plugin",
                "@capybearista/plugin",
                "./invalid-local",
                "file:../invalid-file",
                "valid-plugin-2@latest"
            ]
        }}"#
        )
        .unwrap();

        let plugins = extract_plugins_from_file(file.path(), ConfigScope::Project).unwrap();
        assert_eq!(plugins.len(), 3);
        assert_eq!(plugins[0].spec, "valid-plugin");
        assert_eq!(plugins[1].spec, "@capybearista/plugin");
        assert_eq!(plugins[2].spec, "valid-plugin-2@latest");
    }

    #[test]
    fn test_project_config_paths() {
        let provider = ProjectConfigProvider::new(PathBuf::from("/my/project"));
        let paths = provider.config_paths().unwrap();
        assert_eq!(paths.len(), 4);
        assert_eq!(
            paths[0],
            PathBuf::from("/my/project/.opencode/opencode.jsonc")
        );
        assert_eq!(
            paths[1],
            PathBuf::from("/my/project/.opencode/opencode.json")
        );
        assert_eq!(paths[2], PathBuf::from("/my/project/opencode.jsonc"));
        assert_eq!(paths[3], PathBuf::from("/my/project/opencode.json"));

        let provider2 = ProjectConfigProvider::new(PathBuf::from("/my/project/.opencode"));
        let paths2 = provider2.config_paths().unwrap();
        assert_eq!(paths2.len(), 4);
        assert_eq!(
            paths2[0],
            PathBuf::from("/my/project/.opencode/opencode.jsonc")
        );
        assert_eq!(
            paths2[1],
            PathBuf::from("/my/project/.opencode/opencode.json")
        );
        assert_eq!(paths2[2], PathBuf::from("/my/project/opencode.jsonc"));
        assert_eq!(paths2[3], PathBuf::from("/my/project/opencode.json"));
    }
}
