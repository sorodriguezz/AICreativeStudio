//! Procesamiento de imagen determinista (sin IA): encuadre, formatos, íconos,
//! paletas y vectorización. Vive en Rust para funcionar aunque el motor de IA
//! esté ocupado o apagado, y para compilar igual en todas las plataformas.

use std::io::BufWriter;
use std::path::Path;

use image::codecs::ico::{IcoEncoder, IcoFrame};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub fn load(path: &Path) -> AppResult<RgbaImage> {
    Ok(image::open(path).map_err(|e| AppError::Invalid(format!("No se pudo leer la imagen: {e}")))?.to_rgba8())
}

/// ¿Tiene transparencia real? (no basta con tener canal alfa: debe usarse).
pub fn has_transparency(img: &RgbaImage) -> bool {
    let total = img.pixels().len().max(1);
    let clear = img.pixels().filter(|p| p[3] < 16).count();
    clear * 50 > total // más del 2 % transparente
}

/// Recorta al contenido visible (alfa) y deja un margen proporcional.
pub fn trim(img: &RgbaImage, pad_ratio: f32) -> RgbaImage {
    let (w, h) = img.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p[3] > 8 {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x1 < x0 || y1 < y0 {
        return img.clone();
    }
    let cropped = imageops::crop_imm(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image();
    let pad = ((cropped.width().max(cropped.height()) as f32) * pad_ratio).round() as u32;
    let mut out = RgbaImage::from_pixel(cropped.width() + pad * 2, cropped.height() + pad * 2, Rgba([0, 0, 0, 0]));
    imageops::overlay(&mut out, &cropped, pad as i64, pad as i64);
    out
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// Llena el cuadro recortando lo que sobra.
    Cover,
    /// Cabe completo; el resto se rellena con el fondo.
    Contain,
}

/// Lleva la imagen exactamente a `w×h`.
pub fn fit(img: &RgbaImage, w: u32, h: u32, mode: Fit, background: Option<[u8; 4]>, padding: f32) -> RgbaImage {
    let bg = Rgba(background.unwrap_or([0, 0, 0, 0]));
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    match mode {
        Fit::Cover => {
            let s = (w as f32 / iw).max(h as f32 / ih);
            let (rw, rh) = (((iw * s).round() as u32).max(w), ((ih * s).round() as u32).max(h));
            let resized = imageops::resize(img, rw, rh, FilterType::Lanczos3);
            let mut out = imageops::crop_imm(&resized, (rw - w) / 2, (rh - h) / 2, w, h).to_image();
            if background.is_some() {
                let mut base = RgbaImage::from_pixel(w, h, bg);
                imageops::overlay(&mut base, &out, 0, 0);
                out = base;
            }
            out
        }
        Fit::Contain => {
            let (aw, ah) = (w as f32 * (1.0 - padding * 2.0), h as f32 * (1.0 - padding * 2.0));
            let s = (aw / iw).min(ah / ih);
            let (rw, rh) = (((iw * s).round() as u32).max(1), ((ih * s).round() as u32).max(1));
            let resized = imageops::resize(img, rw, rh, FilterType::Lanczos3);
            let mut out = RgbaImage::from_pixel(w, h, bg);
            imageops::overlay(&mut out, &resized, ((w - rw) / 2) as i64, ((h - rh) / 2) as i64);
            out
        }
    }
}

/// Mismo dibujo, otro color (versión monocromática de un logo).
pub fn tint(img: &RgbaImage, rgb: [u8; 3]) -> RgbaImage {
    let mut out = img.clone();
    for p in out.pixels_mut() {
        *p = Rgba([rgb[0], rgb[1], rgb[2], p[3]]);
    }
    out
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Jpg,
    Webp,
    Ico,
    Svg,
}

impl Format {
    pub fn ext(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpg => "jpg",
            Format::Webp => "webp",
            Format::Ico => "ico",
            Format::Svg => "svg",
        }
    }
}

fn io_err(e: impl std::fmt::Display) -> AppError {
    AppError::Invalid(format!("No se pudo guardar: {e}"))
}

/// Guarda en el formato pedido. JPG no admite transparencia: se aplana sobre `flatten` (blanco por defecto).
pub fn save(img: &RgbaImage, path: &Path, format: Format, quality: u8, flatten: Option<[u8; 4]>) -> AppResult<()> {
    match format {
        Format::Png => img.save_with_format(path, image::ImageFormat::Png).map_err(io_err),
        Format::Webp => img.save_with_format(path, image::ImageFormat::WebP).map_err(io_err),
        Format::Jpg => {
            let mut base = RgbaImage::from_pixel(img.width(), img.height(), Rgba(flatten.unwrap_or([255, 255, 255, 255])));
            imageops::overlay(&mut base, img, 0, 0);
            let rgb = DynamicImage::ImageRgba8(base).to_rgb8();
            let file = BufWriter::new(std::fs::File::create(path)?);
            JpegEncoder::new_with_quality(file, quality.clamp(40, 100))
                .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
                .map_err(io_err)
        }
        Format::Ico => save_ico(img, path, &[16, 32, 48]),
        Format::Svg => std::fs::write(path, vectorize(img, VectorStyle::Detailed)?).map_err(io_err),
    }
}

/// `.ico` con varias resoluciones dentro (favicon clásico).
pub fn save_ico(img: &RgbaImage, path: &Path, sizes: &[u32]) -> AppResult<()> {
    let frames = sizes
        .iter()
        .map(|&s| {
            let square = fit(img, s, s, Fit::Contain, None, 0.0);
            IcoFrame::as_png(square.as_raw(), s, s, ExtendedColorType::Rgba8).map_err(io_err)
        })
        .collect::<AppResult<Vec<_>>>()?;
    let file = BufWriter::new(std::fs::File::create(path)?);
    IcoEncoder::new(file).encode_images(&frames).map_err(io_err)
}

// ---------- Paleta ----------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Swatch {
    pub hex: String,
    pub rgb: [u8; 3],
    /// Proporción del dibujo que ocupa este color (0..1).
    pub share: f32,
}

pub fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

pub fn parse_hex(s: &str) -> Option<[u8; 4]> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 && s.len() != 8 {
        return None;
    }
    let b = |i: usize| u8::from_str_radix(&s[i..i + 2], 16).ok();
    Some([b(0)?, b(2)?, b(4)?, if s.len() == 8 { b(6)? } else { 255 }])
}

pub fn luminance(rgb: [u8; 3]) -> f32 {
    let lin = |c: u8| {
        let c = c as f32 / 255.0;
        if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

/// Contraste WCAG entre dos colores (1..21).
pub fn contrast(a: [u8; 3], b: [u8; 3]) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// Colores dominantes del contenido opaco (k-means determinista sobre una muestra).
pub fn palette(img: &RgbaImage, k: usize) -> Vec<Swatch> {
    let small = imageops::thumbnail(img, 128, 128);
    let pixels: Vec<[f32; 3]> = small
        .pixels()
        .filter(|p| p[3] > 200)
        .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
        .collect();
    if pixels.is_empty() {
        return vec![];
    }
    // Semillas repartidas por luminancia para que el resultado sea estable.
    let mut sorted = pixels.clone();
    sorted.sort_by(|a, b| (a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11).total_cmp(&(b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11)));
    let k = k.min(sorted.len());
    let mut centers: Vec<[f32; 3]> = (0..k).map(|i| sorted[(i * 2 + 1) * sorted.len() / (k * 2)]).collect();
    let mut assign = vec![0usize; pixels.len()];
    for _ in 0..12 {
        for (i, p) in pixels.iter().enumerate() {
            assign[i] = (0..k)
                .min_by(|&a, &b| dist(p, &centers[a]).total_cmp(&dist(p, &centers[b])))
                .unwrap_or(0);
        }
        let mut sums = vec![[0f32; 4]; k];
        for (i, p) in pixels.iter().enumerate() {
            let s = &mut sums[assign[i]];
            s[0] += p[0];
            s[1] += p[1];
            s[2] += p[2];
            s[3] += 1.0;
        }
        for (c, s) in centers.iter_mut().zip(&sums) {
            if s[3] > 0.0 {
                *c = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
            }
        }
    }
    let mut counts = vec![0usize; k];
    for a in &assign {
        counts[*a] += 1;
    }
    let mut swatches: Vec<Swatch> = Vec::new();
    for (c, n) in centers.iter().zip(counts) {
        if n == 0 {
            continue;
        }
        let rgb = [c[0].round() as u8, c[1].round() as u8, c[2].round() as u8];
        // Une colores casi iguales.
        if let Some(existing) = swatches.iter_mut().find(|s| dist(&[s.rgb[0] as f32, s.rgb[1] as f32, s.rgb[2] as f32], c) < 30.0 * 30.0) {
            existing.share += n as f32 / pixels.len() as f32;
            continue;
        }
        swatches.push(Swatch { hex: hex(rgb), rgb, share: n as f32 / pixels.len() as f32 });
    }
    swatches.sort_by(|a, b| b.share.total_cmp(&a.share));
    swatches
}

fn dist(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}

// ---------- Vectorización ----------

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VectorStyle {
    /// Pocos colores, curvas limpias: logos e íconos.
    Logo,
    /// Más colores y detalle: ilustraciones.
    Detailed,
}

/// Convierte a SVG con vtracer. Normaliza el tamaño para curvas suaves y tiempos acotados.
pub fn vectorize(img: &RgbaImage, style: VectorStyle) -> AppResult<String> {
    let longest = img.width().max(img.height()).max(1);
    let target = if longest < 600 { longest * 2 } else { longest.min(1400) };
    let scaled = if target != longest {
        let s = target as f32 / longest as f32;
        imageops::resize(img, ((img.width() as f32 * s).round() as u32).max(1), ((img.height() as f32 * s).round() as u32).max(1), FilterType::Lanczos3)
    } else {
        img.clone()
    };
    let mut config = vtracer::Config::from_preset(vtracer::Preset::Poster);
    match style {
        VectorStyle::Logo => {
            config.filter_speckle = 8;
            config.color_precision = 5;
            config.layer_difference = 32;
            config.corner_threshold = 60;
            config.length_threshold = 5.0;
        }
        VectorStyle::Detailed => {
            config.filter_speckle = 4;
            config.color_precision = 7;
            config.layer_difference = 16;
        }
    }
    let color_image = vtracer::ColorImage { pixels: scaled.as_raw().clone(), width: scaled.width() as usize, height: scaled.height() as usize };
    let svg = vtracer::convert(color_image, config).map_err(|e| AppError::Invalid(format!("No se pudo vectorizar: {e}")))?;
    Ok(svg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn logo() -> RgbaImage {
        // Disco rojo con centro azul sobre fondo transparente, desplazado del centro.
        RgbaImage::from_fn(200, 120, |x, y| {
            let (dx, dy) = (x as f32 - 60.0, y as f32 - 60.0);
            let r = (dx * dx + dy * dy).sqrt();
            if r < 15.0 { Rgba([20, 60, 200, 255]) } else if r < 40.0 { Rgba([220, 40, 30, 255]) } else { Rgba([0, 0, 0, 0]) }
        })
    }

    #[test]
    fn transparency_and_trim() {
        let img = logo();
        assert!(has_transparency(&img));
        assert!(!has_transparency(&RgbaImage::from_pixel(10, 10, Rgba([1, 2, 3, 255]))));
        let t = trim(&img, 0.0);
        assert!((79..=81).contains(&t.width()) && (79..=81).contains(&t.height()));
    }

    #[test]
    fn fit_modes_produce_exact_sizes() {
        let img = logo();
        for mode in [Fit::Cover, Fit::Contain] {
            let out = fit(&img, 300, 100, mode, Some([255, 255, 255, 255]), 0.1);
            assert_eq!(out.dimensions(), (300, 100));
        }
        let contained = fit(&img, 300, 300, Fit::Contain, Some([255, 255, 255, 255]), 0.0);
        assert_eq!(contained.get_pixel(150, 2)[3], 255); // relleno opaco con el fondo
    }

    #[test]
    fn palette_finds_dominant_colors() {
        let p = palette(&logo(), 4);
        let near = |a: [u8; 3], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() <= 12);
        assert!(near(p[0].rgb, [220, 40, 30]), "{:?}", p[0]); // el rojo ocupa más superficie
        assert!(p.iter().any(|s| s.rgb[2] > 180 && s.rgb[0] < 60));
        assert!((p.iter().map(|s| s.share).sum::<f32>() - 1.0).abs() < 0.01);
    }

    #[test]
    fn hex_and_contrast() {
        assert_eq!(parse_hex("#ff8000"), Some([255, 128, 0, 255]));
        assert_eq!(parse_hex("nope"), None);
        assert!((contrast([0, 0, 0], [255, 255, 255]) - 21.0).abs() < 0.1);
    }

    #[test]
    fn writes_every_format() {
        let dir = std::env::temp_dir().join(format!("aics-imaging-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = logo();
        for f in [Format::Png, Format::Jpg, Format::Webp, Format::Ico, Format::Svg] {
            let path = dir.join(format!("out.{}", f.ext()));
            save(&img, &path, f, 90, None).unwrap();
            assert!(std::fs::metadata(&path).unwrap().len() > 0, "{f:?}");
        }
        let svg = std::fs::read_to_string(dir.join("out.svg")).unwrap();
        assert!(svg.starts_with("<?xml") || svg.contains("<svg"));
        assert!(svg.contains("<path"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
