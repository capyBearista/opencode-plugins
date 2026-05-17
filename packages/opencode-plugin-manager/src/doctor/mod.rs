use crate::config::provider::ConfigScope;
use crate::discovery::{sort_enriched_plugins, EnrichedPlugin};
use colored::*;
use serde::Serialize;
use std::fmt::Write;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DoctorSeverity {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DoctorFinding {
    pub check: String,
    pub severity: DoctorSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub requested_spec: String,
    pub package_name: String,
    pub scope: String,
    pub config_path: String,
    pub display_name: String,
    pub description: String,
    pub findings: Vec<DoctorFinding>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorOutput {
    pub reports: Vec<DoctorReport>,
}

#[cfg(test)]
mod tests {
    use super::build_doctor_reports;
    use super::DoctorSeverity;
    use crate::catalog::PluginMetadata;
    use crate::config::manifest::PackageManifest;
    use crate::config::provider::ConfigScope;
    use crate::discovery::{EnrichedPlugin, PluginStatus};
    use std::path::PathBuf;

    fn plugin(manifest: Option<PackageManifest>) -> EnrichedPlugin {
        EnrichedPlugin {
            configured_spec: "plugin@latest".to_string(),
            package_name: "plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest,
            catalog_metadata: Some(PluginMetadata {
                package_name: "plugin",
                alias: "plugin",
                display_name: "Plugin",
                description: "Plugin description",
                category: "category",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "Plugin".to_string(),
            description: "Plugin description".to_string(),
            status: PluginStatus::Installed,
        }
    }

    #[test]
    fn build_doctor_reports_marks_manifest_metadata_and_range() {
        let reports = build_doctor_reports(&[plugin(Some(PackageManifest {
            name: "plugin".to_string(),
            version: "1.0.0".to_string(),
            description: Some("Plugin description".to_string()),
            oc_plugin: None,
            engines: None,
        }))]);

        let report = &reports[0];
        assert_eq!(report.requested_spec, "plugin@latest");
        assert_eq!(report.package_name, "plugin");
        assert_eq!(report.scope, "project");
        assert_eq!(report.config_path, "/tmp/opencode.json");
        assert_eq!(report.findings.len(), 3);
        assert_eq!(report.findings[0].severity, DoctorSeverity::Pass);
        assert_eq!(report.findings[1].severity, DoctorSeverity::Warn);
        assert_eq!(report.findings[2].severity, DoctorSeverity::Warn);
    }

    #[test]
    fn build_doctor_reports_fails_when_manifest_is_missing() {
        let reports = build_doctor_reports(&[plugin(None)]);

        let report = &reports[0];
        assert_eq!(report.findings[0].severity, DoctorSeverity::Fail);
        assert_eq!(report.findings[1].severity, DoctorSeverity::Warn);
        assert_eq!(report.findings[2].severity, DoctorSeverity::Warn);
    }
}

pub fn build_doctor_reports(plugins: &[EnrichedPlugin]) -> Vec<DoctorReport> {
    sort_enriched_plugins(plugins)
        .into_iter()
        .map(build_doctor_report)
        .collect()
}

pub fn build_doctor_output(plugins: &[EnrichedPlugin]) -> DoctorOutput {
    DoctorOutput {
        reports: build_doctor_reports(plugins),
    }
}

pub fn render_doctor_reports(reports: &[DoctorReport]) -> String {
    if reports.is_empty() {
        return "No configured plugins found.\n".to_string();
    }

    let mut output = String::new();
    writeln!(output, "{}", "Configured OpenCode plugins".bold()).unwrap();
    writeln!(output).unwrap();

    let mut current_scope: Option<String> = None;
    for report in reports {
        if current_scope.as_deref() != Some(report.scope.as_str()) {
            if current_scope.is_some() {
                writeln!(output).unwrap();
            }
            writeln!(output, "{}", scope_heading_label(&report.scope).bold()).unwrap();
            current_scope = Some(report.scope.clone());
        }

        writeln!(output, "  {}", report.display_name.bold()).unwrap();
        if !report.description.is_empty() {
            writeln!(output, "  {}", report.description.dimmed()).unwrap();
        }
        writeln!(output, "  {}", report.package_name.dimmed()).unwrap();

        for finding in &report.findings {
            writeln!(
                output,
                "    [{}] {}",
                severity_label(&finding.severity),
                finding.message
            )
            .unwrap();
        }
        writeln!(output).unwrap();
    }

    output
}

pub fn print_doctor_reports(reports: &[DoctorReport]) {
    print!("{}", render_doctor_reports(reports));
}

fn build_doctor_report(plugin: &EnrichedPlugin) -> DoctorReport {
    let manifest = plugin.manifest.as_ref();
    let findings = vec![
        match manifest {
            Some(_) => DoctorFinding {
                check: "installed package resolution".to_string(),
                severity: DoctorSeverity::Pass,
                message: "installed package manifest found".to_string(),
            },
            None => DoctorFinding {
                check: "installed package resolution".to_string(),
                severity: DoctorSeverity::Fail,
                message: "installed package manifest missing".to_string(),
            },
        },
        match manifest.and_then(|manifest| manifest.oc_plugin.as_ref()) {
            Some(_) => DoctorFinding {
                check: "OpenCode plugin metadata presence".to_string(),
                severity: DoctorSeverity::Pass,
                message: "OpenCode plugin metadata found".to_string(),
            },
            None => DoctorFinding {
                check: "OpenCode plugin metadata presence".to_string(),
                severity: DoctorSeverity::Warn,
                message: "OpenCode plugin metadata missing".to_string(),
            },
        },
        match manifest
            .and_then(|manifest| manifest.engines.as_ref())
            .and_then(|engines| engines.opencode.as_ref())
        {
            Some(range) => DoctorFinding {
                check: "declared OpenCode support range".to_string(),
                severity: DoctorSeverity::Pass,
                message: format!("declares OpenCode support: {range}"),
            },
            None => DoctorFinding {
                check: "declared OpenCode support range".to_string(),
                severity: DoctorSeverity::Warn,
                message: "no declared OpenCode support range".to_string(),
            },
        },
    ];

    DoctorReport {
        requested_spec: plugin.configured_spec.clone(),
        package_name: plugin.package_name.clone(),
        scope: scope_label(&plugin.scope).to_string(),
        config_path: plugin.config_path.display().to_string(),
        display_name: plugin.display_name.clone(),
        description: plugin.description.clone(),
        findings,
    }
}

fn scope_label(scope: &ConfigScope) -> &'static str {
    match scope {
        ConfigScope::Project => "project",
        ConfigScope::Global => "global",
    }
}

fn scope_heading_label(scope: &str) -> &str {
    match scope {
        "project" => "Project",
        "global" => "Global",
        _ => scope,
    }
}

fn severity_label(severity: &DoctorSeverity) -> &'static str {
    match severity {
        DoctorSeverity::Pass => "PASS",
        DoctorSeverity::Warn => "WARN",
        DoctorSeverity::Fail => "FAIL",
    }
}
