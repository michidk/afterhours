//! Native city-generator entry point.
//!
//! The stage implementations are being ported in dependency order. This binary
//! intentionally fails until the native pipeline and artifact conversion land;
//! it never invokes the TypeScript oracle.

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("generate-city: native Rust pipeline is not complete yet");
    eprintln!("the TypeScript generator is available only as the parity oracle");
    ExitCode::from(1)
}
