//! Kits de marca: a partir de un logo con fondo transparente genera variantes,
//! íconos, piezas para redes, paleta y una guía HTML, todo en una carpeta.

use std::path::{Path, PathBuf};

use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::imaging::{self, Fit, Format, Swatch, VectorStyle};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct KitColors {
    pub primary: String,
    pub light: String,
    pub dark: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KitFile {
    pub group: String,
    pub label: String,
    /// Ruta relativa a la carpeta del kit.
    pub rel: String,
    pub width: u32,
    pub height: u32,
    /// Fondo sobre el que se ve mejor en la vista previa.
    pub surface: String,
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "imagen".into() } else { out }
}

fn rgb_of(hex: &str) -> [u8; 3] {
    let c = imaging::parse_hex(hex).unwrap_or([0, 0, 0, 255]);
    [c[0], c[1], c[2]]
}

fn saturation(rgb: [u8; 3]) -> f32 {
    let max = *rgb.iter().max().unwrap() as f32;
    let min = *rgb.iter().min().unwrap() as f32;
    if max == 0.0 { 0.0 } else { (max - min) / max }
}

/// Elige primario (el color de marca más característico), claro y oscuro de apoyo.
pub fn derive_colors(palette: &[Swatch]) -> KitColors {
    let chromatic = palette
        .iter()
        .filter(|s| s.share >= 0.05 && saturation(s.rgb) > 0.25 && (0.02..0.9).contains(&imaging::luminance(s.rgb)))
        .max_by(|a, b| (a.share * (0.5 + saturation(a.rgb))).total_cmp(&(b.share * (0.5 + saturation(b.rgb)))));
    let primary = chromatic.or(palette.first()).map(|s| s.hex.clone()).unwrap_or_else(|| "#222222".into());
    let light = palette.iter().find(|s| imaging::luminance(s.rgb) > 0.85).map(|s| s.hex.clone()).unwrap_or_else(|| "#FFFFFF".into());
    let dark = palette.iter().find(|s| imaging::luminance(s.rgb) < 0.03).map(|s| s.hex.clone()).unwrap_or_else(|| "#141414".into());
    KitColors { primary, light, dark }
}

struct Writer<'a> {
    dir: &'a Path,
    files: Vec<KitFile>,
}

impl Writer<'_> {
    fn png(&mut self, group: &str, label: &str, rel: &str, img: &RgbaImage, surface: &str) -> AppResult<()> {
        let path = self.dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap())?;
        imaging::save(img, &path, Format::Png, 100, None)?;
        self.files.push(KitFile { group: group.into(), label: label.into(), rel: rel.into(), width: img.width(), height: img.height(), surface: surface.into() });
        Ok(())
    }

    fn raw(&mut self, group: &str, label: &str, rel: &str, bytes: &[u8], size: (u32, u32), surface: &str) -> AppResult<()> {
        let path = self.dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, bytes)?;
        self.files.push(KitFile { group: group.into(), label: label.into(), rel: rel.into(), width: size.0, height: size.1, surface: surface.into() });
        Ok(())
    }
}

/// Lienzo con la proporción del logo y `longest` px en su lado mayor.
fn framed(logo: &RgbaImage, longest: u32, bg: Option<[u8; 4]>, pad: f32) -> RgbaImage {
    let (w, h) = (logo.width() as f32, logo.height() as f32);
    let s = longest as f32 / w.max(h);
    let (cw, ch) = (((w * s) / (1.0 - pad * 2.0)).round() as u32, ((h * s) / (1.0 - pad * 2.0)).round() as u32);
    imaging::fit(logo, cw.max(1), ch.max(1), Fit::Contain, bg, pad)
}

fn square(logo: &RgbaImage, size: u32, bg: Option<[u8; 4]>, pad: f32) -> RgbaImage {
    imaging::fit(logo, size, size, Fit::Contain, bg, pad)
}

fn rgba(hex: &str) -> Option<[u8; 4]> {
    imaging::parse_hex(hex)
}

/// Genera todos los archivos del kit en `dir`. Devuelve paleta, colores y archivos.
pub fn build_kit(logo: &RgbaImage, name: &str, dir: &Path) -> AppResult<(Vec<Swatch>, KitColors, Vec<KitFile>)> {
    std::fs::create_dir_all(dir)?;
    let mut trimmed = imaging::trim(logo, 0.0);
    if trimmed.width().max(trimmed.height()) > 2048 {
        trimmed = framed(&trimmed, 2048, None, 0.0);
    }
    let palette = imaging::palette(&trimmed, 6);
    let colors = derive_colors(&palette);
    let (primary, dark) = (rgb_of(&colors.primary), rgb_of(&colors.dark));
    // Sobre el color de marca, el logo va en blanco o negro según contraste.
    let on_brand_rgb = if imaging::contrast([255, 255, 255], primary) >= 3.0 { [255, 255, 255] } else { [20, 20, 20] };
    // Sobre oscuro, el logo original sólo si su color principal contrasta; si no, en blanco.
    let logo_main = palette.first().map(|s| s.rgb).unwrap_or(primary);
    let on_dark = if imaging::contrast(logo_main, dark) >= 3.0 { trimmed.clone() } else { imaging::tint(&trimmed, [255, 255, 255]) };

    let mut w = Writer { dir, files: Vec::new() };
    let logo_group = "Logotipo";
    w.png(logo_group, "Logo · fondo transparente", "logo/logo.png", &framed(&trimmed, 1600, None, 0.04), "checker")?;
    let svg = imaging::vectorize(&framed(&trimmed, 1200, None, 0.04), VectorStyle::Logo)?;
    w.raw(logo_group, "Logo vectorial (SVG)", "logo/logo.svg", svg.as_bytes(), (trimmed.width(), trimmed.height()), "checker")?;
    w.png(logo_group, "Sobre fondo claro", "logo/logo-sobre-claro.png", &framed(&trimmed, 1600, rgba(&colors.light), 0.14), &colors.light)?;
    w.png(logo_group, "Sobre fondo oscuro", "logo/logo-sobre-oscuro.png", &framed(&on_dark, 1600, rgba(&colors.dark), 0.14), &colors.dark)?;
    w.png(logo_group, "Sobre color de marca", "logo/logo-sobre-marca.png", &framed(&imaging::tint(&trimmed, on_brand_rgb), 1600, rgba(&colors.primary), 0.14), &colors.primary)?;
    w.png(logo_group, "Monocromo negro", "logo/logo-negro.png", &framed(&imaging::tint(&trimmed, [0, 0, 0]), 1600, None, 0.04), "#FFFFFF")?;
    w.png(logo_group, "Monocromo blanco", "logo/logo-blanco.png", &framed(&imaging::tint(&trimmed, [255, 255, 255]), 1600, None, 0.04), "#141414")?;

    let icons = "Íconos";
    let ico_path = dir.join("iconos/favicon.ico");
    std::fs::create_dir_all(ico_path.parent().unwrap())?;
    imaging::save_ico(&square(&trimmed, 256, None, 0.04), &ico_path, &[16, 32, 48])?;
    w.files.push(KitFile { group: icons.into(), label: "Favicon .ico (16, 32, 48)".into(), rel: "iconos/favicon.ico".into(), width: 48, height: 48, surface: "checker".into() });
    w.png(icons, "Favicon 32 px", "iconos/favicon-32.png", &square(&trimmed, 32, None, 0.04), "checker")?;
    w.png(icons, "Apple touch 180 px", "iconos/apple-touch-icon.png", &square(&trimmed, 180, rgba(&colors.light), 0.14), &colors.light)?;
    w.png(icons, "Web app 192 px", "iconos/icon-192.png", &square(&trimmed, 192, None, 0.06), "checker")?;
    w.png(icons, "Web app 512 px", "iconos/icon-512.png", &square(&trimmed, 512, None, 0.06), "checker")?;
    w.png(icons, "Ícono de app 1024 px", "iconos/app-icon-1024.png", &square(&trimmed, 1024, rgba(&colors.light), 0.18), &colors.light)?;

    let social = "Redes sociales";
    w.png(social, "Avatar 400 px", "redes/avatar-400.png", &square(&trimmed, 400, rgba(&colors.light), 0.16), &colors.light)?;
    w.png(social, "Avatar de marca 400 px", "redes/avatar-marca-400.png", &square(&imaging::tint(&trimmed, on_brand_rgb), 400, rgba(&colors.primary), 0.2), &colors.primary)?;
    w.png(social, "Portada 1500×500", "redes/portada-1500x500.png", &imaging::fit(&trimmed, 1500, 500, Fit::Contain, rgba(&colors.light), 0.2), &colors.light)?;

    let guide = "Paleta y guía";
    let palette_json = serde_json::to_string_pretty(&serde_json::json!({ "name": name, "colors": colors, "palette": palette }))
        .unwrap_or_default();
    w.raw(guide, "Paleta (JSON)", "paleta.json", palette_json.as_bytes(), (0, 0), "")?;
    w.raw(guide, "Variables CSS", "paleta.css", palette_css(&colors, &palette).as_bytes(), (0, 0), "")?;
    w.raw(guide, "Guía de marca (HTML)", "guia.html", guide_html(name, &colors, &palette).as_bytes(), (0, 0), "")?;
    Ok((palette, colors, w.files))
}

fn palette_css(colors: &KitColors, palette: &[Swatch]) -> String {
    let mut css = String::from(":root {\n");
    css += &format!("  --brand-primary: {};\n  --brand-light: {};\n  --brand-dark: {};\n", colors.primary, colors.light, colors.dark);
    for (i, s) in palette.iter().enumerate() {
        css += &format!("  --brand-{}: {};\n", i + 1, s.hex);
    }
    css + "}\n"
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn guide_html(name: &str, colors: &KitColors, palette: &[Swatch]) -> String {
    let swatches: String = palette
        .iter()
        .map(|s| {
            let ink = if imaging::contrast(s.rgb, [255, 255, 255]) >= 4.5 { "#fff" } else { "#111" };
            format!(
                r#"<figure class="sw" style="background:{hex};color:{ink}"><b>{hex}</b><span>RGB {r} {g} {b}</span><span>{share:.0}% del logo</span><span>Contraste: {cw:.1} sobre blanco · {cb:.1} sobre negro</span></figure>"#,
                hex = s.hex, r = s.rgb[0], g = s.rgb[1], b = s.rgb[2], share = s.share * 100.0,
                cw = imaging::contrast(s.rgb, [255, 255, 255]), cb = imaging::contrast(s.rgb, [0, 0, 0]),
            )
        })
        .collect();
    format!(
        r#"<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} — Guía de marca</title>
<style>
:root {{ --primary:{primary}; --light:{light}; --dark:{dark}; }}
* {{ box-sizing:border-box }} body {{ margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1b1b1b; background:#faf8f4 }}
header {{ padding:64px 8vw 40px; background:var(--light); border-bottom:1px solid #0001 }}
h1 {{ font:700 52px/1.05 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.04em; margin:0 0 8px }} h2 {{ font:650 24px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.025em; margin:56px 0 16px }}
main {{ padding:0 8vw 80px }} .row {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px }}
.card {{ border-radius:12px; padding:28px; display:grid; place-items:center; min-height:200px; border:1px solid #0001 }}
.card img {{ max-width:100%; max-height:150px }} .cap {{ font-size:13px; color:#666; margin-top:8px }}
.sw {{ margin:0; border-radius:12px; padding:20px; min-height:150px; display:flex; flex-direction:column; gap:2px; justify-content:flex-end }}
.sw b {{ font-size:20px }} .sw span {{ font-size:12px; opacity:.85 }}
.checker {{ background:repeating-conic-gradient(#e8e4dc 0 25%,#fff 0 50%) 0 0/20px 20px }}
.icons {{ display:flex; gap:24px; align-items:flex-end }} code {{ background:#0000000d; padding:2px 6px; border-radius:4px }}
</style></head><body>
<header><img src="logo/logo.png" alt="" style="height:96px"><h1>{title}</h1><p>Guía de marca generada con AICreativeStudio.</p></header>
<main>
<h2>Logotipo</h2>
<div class="row">
<div><div class="card" style="background:var(--light)"><img src="logo/logo.png" alt=""></div><div class="cap">Uso principal sobre fondo claro</div></div>
<div><div class="card" style="background:var(--dark)"><img src="logo/logo-sobre-oscuro.png" alt=""></div><div class="cap">Sobre fondo oscuro</div></div>
<div><div class="card" style="background:var(--primary)"><img src="logo/logo-sobre-marca.png" alt=""></div><div class="cap">Sobre el color de marca</div></div>
<div><div class="card checker"><img src="logo/logo.svg" alt=""></div><div class="cap">Vectorial: <code>logo/logo.svg</code></div></div>
</div>
<p>Deja alrededor del logo un margen libre de al menos la mitad de su altura. No lo estires, no cambies sus colores fuera de esta paleta y no le agregues sombras ni efectos.</p>
<h2>Paleta</h2>
<div class="row">{swatches}</div>
<p>Variables listas para usar en <code>paleta.css</code>. Para texto, usa combinaciones con contraste de 4.5 o más.</p>
<h2>Íconos</h2>
<div class="icons"><img src="iconos/favicon-32.png" width="32" alt=""><img src="iconos/apple-touch-icon.png" width="90" alt=""><img src="iconos/icon-192.png" width="96" alt=""><img src="iconos/app-icon-1024.png" width="128" alt=""></div>
</main></body></html>"#,
        title = escape(name), primary = colors.primary, light = colors.light, dark = colors.dark,
    )
}

/// Copia la carpeta del kit a `dest` y devuelve la ruta creada.
pub fn copy_kit(src: &Path, dest: &Path, name: &str) -> AppResult<PathBuf> {
    let mut target = dest.join(format!("{}-kit", slug(name)));
    let mut n = 2;
    while target.exists() {
        target = dest.join(format!("{}-kit-{n}", slug(name)));
        n += 1;
    }
    copy_dir(src, &target)?;
    Ok(target)
}

fn copy_dir(src: &Path, dest: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn slugs_are_safe() {
        assert_eq!(slug("Café Aurora — Logo ñandú!"), "cafe-aurora-logo-nandu");
        assert_eq!(slug("¿?"), "imagen");
    }

    #[test]
    fn builds_a_complete_kit() {
        let logo = RgbaImage::from_fn(300, 200, |x, y| {
            let (dx, dy) = (x as f32 - 150.0, y as f32 - 100.0);
            if (dx * dx + dy * dy).sqrt() < 70.0 { Rgba([230, 90, 20, 255]) } else { Rgba([0, 0, 0, 0]) }
        });
        let dir = std::env::temp_dir().join(format!("aics-kit-{}", std::process::id()));
        let (palette, colors, files) = build_kit(&logo, "Café <Aurora>", &dir).unwrap();
        assert_eq!(colors.primary, palette[0].hex);
        assert_eq!(colors.light, "#FFFFFF");
        for f in &files {
            assert!(dir.join(&f.rel).is_file(), "{}", f.rel);
        }
        assert!(files.iter().any(|f| f.rel == "iconos/favicon.ico"));
        assert!(std::fs::read_to_string(dir.join("guia.html")).unwrap().contains("Café &lt;Aurora&gt;"));
        assert!(std::fs::read_to_string(dir.join("paleta.css")).unwrap().contains("--brand-primary"));
        let copied = copy_kit(&dir, &std::env::temp_dir(), "Café Aurora").unwrap();
        assert!(copied.join("logo/logo.svg").is_file());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&copied);
    }
}
