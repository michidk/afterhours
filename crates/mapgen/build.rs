fn main() {
    println!("cargo:rerun-if-changed=src/v8_ieee754.cc");
    cc::Build::new()
        .cpp(true)
        .file("src/v8_ieee754.cc")
        .flag_if_supported("-std=c++20")
        .flag_if_supported("-ffp-contract=off")
        .compile("afterhours_v8_math");
}
