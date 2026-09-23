fn main() {
    tauri_build::build();

    // Windows：给**非 bin 目标**（`cargo test` 的测试二进制）补上 comctl32 v6 的
    // SideBySide 依赖清单。
    //
    // 背景（踩过的坑）：muda / tray-icon 会引用 comctl32 v6 专属导出
    // （TaskDialogIndirect），而 tauri-build 生成的 `resource.lib` 只通过
    // `rustc-link-arg-bins` 链给 bin。测试二进制没有 v6 清单时，Windows 会去加载
    // system32 里的 comctl32 v5.82 → 进程在**加载阶段**直接
    // STATUS_ENTRYPOINT_NOT_FOUND（0xc0000139），表现为 `cargo test` 全部起不来。
    //
    // 为什么给 bin 加 /MANIFEST:NO：
    // - bin 已经有 `resource.lib` 里的 RT_MANIFEST（tauri-build 生成，含图标/版本信息），
    //   再加 /MANIFEST:EMBED 会撞出 `CVT1100: duplicate resource. type:MANIFEST, name:1`；
    // - 反过来把 resource.lib 也链给全部目标，会让 bin 重复列同一个库
    //   （`CVT1100: duplicate resource. type:VERSION, name:1`）；
    // - 所以：清单只对「非 bin」生效，bin 沿用 tauri-build 的那一份。
    #[cfg(windows)]
    {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("windows")
            .join("common-controls.manifest");
        let path = manifest.display().to_string();
        // 路径含空格时给 linker 加引号（rustc 不会替我们转义）
        let manifest_input = if path.contains(' ') {
            format!("/MANIFESTINPUT:\"{}\"", path)
        } else {
            format!("/MANIFESTINPUT:{}", path)
        };
        println!("cargo:rerun-if-changed={}", path);
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg={}", manifest_input);
        // bin 不要再生成本地清单（保留 resource.lib 里那份，避免重复资源）；
        // /IGNORE:4075 静默「因 /MANIFEST:NO 而忽略 /MANIFESTINPUT」这条**预期内**的警告
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!("cargo:rustc-link-arg-bins=/IGNORE:4075");
    }
}
