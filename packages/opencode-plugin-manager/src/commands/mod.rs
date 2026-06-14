pub mod add;
pub mod remove;
pub mod update;

use crate::errors::CliError;

/// Prompt the user for confirmation on stdin.
///
/// Returns `Ok(true)` if the user confirms, `Ok(false)` otherwise.
/// When `yes` is true, skips the prompt and returns `Ok(true)` immediately.
pub fn confirm(prompt: &str, yes: bool) -> Result<bool, CliError> {
    if yes {
        return Ok(true);
    }

    eprint!("{prompt} [y/N] ");
    let mut input = String::new();
    std::io::stdin()
        .read_line(&mut input)
        .map_err(|e| CliError::Io {
            path: "stdin".to_string(),
            source: e,
        })?;

    let trimmed = input.trim().to_lowercase();
    Ok(trimmed == "y" || trimmed == "yes")
}
