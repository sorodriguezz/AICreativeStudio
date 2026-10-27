//! Personas reales y sus fotos de referencia.
//!
//! Reglas (además de la política del motor):
//!   - Usar la identidad de alguien (generar imágenes nuevas, cambiar su pose) exige una persona
//!     registrada, mayor de edad y con fotos de referencia. El consentimiento lo gestiona el usuario fuera de la app.
//!   - Cada acción queda en `audit_log` (trazabilidad).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::new_id;
use crate::error::{AppError, AppResult};

/// Operaciones que usan la identidad de una persona y por eso exigen elegir una registrada.
pub fn needs_identity(operation: &str) -> bool {
    matches!(operation, "identity_generate" | "pose_change")
}

#[derive(Serialize, Debug, Clone)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub notes: Option<String>,
    pub is_adult: bool,
    pub created_at: String,
    pub reference_count: i64,
    pub cover_path: Option<String>,
    pub generated_count: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct Reference {
    pub id: String,
    pub person_id: String,
    pub path: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub face: Value,
    pub created_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct AuditEntry {
    pub action: String,
    pub detail: Value,
    pub created_at: String,
}

pub fn audit(conn: &Connection, person_id: Option<&str>, action: &str, detail: Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO audit_log (id, person_id, action, detail_json) VALUES (?1, ?2, ?3, ?4)",
        params![new_id(), person_id, action, detail.to_string()],
    )?;
    Ok(())
}

fn person_from_row(r: &Row) -> rusqlite::Result<Person> {
    Ok(Person {
        id: r.get("id")?,
        name: r.get("name")?,
        notes: r.get("notes")?,
        is_adult: r.get::<_, i64>("is_adult")? == 1,
        created_at: r.get("created_at")?,
        reference_count: r.get("reference_count")?,
        cover_path: r.get("cover_path")?,
        generated_count: r.get("generated_count")?,
    })
}

const PERSON_SELECT: &str = "SELECT p.*,
    (SELECT COUNT(*) FROM person_references r WHERE r.person_id = p.id) AS reference_count,
    (SELECT r.path FROM person_references r WHERE r.person_id = p.id ORDER BY r.created_at LIMIT 1) AS cover_path,
    (SELECT COUNT(*) FROM assets a WHERE json_extract(a.metadata_json, '$.person_id') = p.id) AS generated_count
    FROM persons p";

pub fn list(conn: &Connection) -> AppResult<Vec<Person>> {
    let mut stmt = conn.prepare(&format!("{PERSON_SELECT} ORDER BY p.name COLLATE NOCASE"))?;
    let rows = stmt.query_map([], person_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Person>> {
    Ok(conn.query_row(&format!("{PERSON_SELECT} WHERE p.id = ?1"), params![id], person_from_row).optional()?)
}

pub fn create(conn: &Connection, name: &str, notes: Option<&str>, is_adult: bool) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("La persona necesita un nombre o alias".into()));
    }
    let id = new_id();
    conn.execute("INSERT INTO persons (id, name, notes, is_adult) VALUES (?1, ?2, ?3, ?4)", params![id, name, notes, is_adult as i64])?;
    audit(conn, Some(&id), "persona_creada", json!({ "name": name, "is_adult": is_adult }))?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, name: &str, notes: Option<&str>, is_adult: Option<bool>) -> AppResult<()> {
    conn.execute(
        "UPDATE persons SET name = ?2, notes = ?3, is_adult = COALESCE(?4, is_adult), updated_at = datetime('now') WHERE id = ?1",
        params![id, name.trim(), notes, is_adult.map(|a| a as i64)],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    audit(conn, Some(id), "persona_eliminada", json!({}))?;
    conn.execute("DELETE FROM persons WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn references(conn: &Connection, person_id: &str) -> AppResult<Vec<Reference>> {
    let mut stmt = conn.prepare("SELECT * FROM person_references WHERE person_id = ?1 ORDER BY created_at, rowid")?;
    let rows = stmt.query_map(params![person_id], |r| {
        Ok(Reference {
            id: r.get("id")?,
            person_id: r.get("person_id")?,
            path: r.get("path")?,
            width: r.get("width")?,
            height: r.get("height")?,
            face: r.get::<_, Option<String>>("face_json")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
            created_at: r.get("created_at")?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn embeddings(conn: &Connection, person_id: &str) -> AppResult<Vec<Vec<f32>>> {
    let mut stmt = conn.prepare("SELECT embedding_json FROM person_references WHERE person_id = ?1")?;
    let rows = stmt.query_map(params![person_id], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|s| s.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (na * nb).max(1e-9)
}

/// Umbral de SFace para "misma persona".
pub const SAME_PERSON: f32 = 0.363;

pub struct NewReference<'a> {
    pub person_id: &'a str,
    pub path: &'a str,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub embedding: &'a [f32],
    pub face: &'a Value,
}

pub fn add_reference(conn: &Connection, r: &NewReference) -> AppResult<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO person_references (id, person_id, path, width, height, embedding_json, face_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, r.person_id, r.path, r.width, r.height, json!(r.embedding).to_string(), r.face.to_string()],
    )?;
    audit(conn, Some(r.person_id), "referencia_agregada", json!({ "reference_id": id }))?;
    Ok(id)
}

pub fn remove_reference(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    let row: Option<(String, String)> = conn
        .query_row("SELECT person_id, path FROM person_references WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    if let Some((person_id, path)) = &row {
        conn.execute("DELETE FROM person_references WHERE id = ?1", params![id])?;
        audit(conn, Some(person_id), "referencia_eliminada", json!({ "reference_id": id }))?;
        return Ok(Some(path.clone()));
    }
    Ok(None)
}

pub fn audit_log(conn: &Connection, person_id: &str, limit: i64) -> AppResult<Vec<AuditEntry>> {
    let mut stmt = conn.prepare("SELECT action, detail_json, created_at FROM audit_log
         WHERE person_id = ?1 AND action NOT LIKE 'consentimiento_%' ORDER BY created_at DESC, rowid DESC LIMIT ?2")?;
    let rows = stmt.query_map(params![person_id, limit], |r| {
        Ok(AuditEntry {
            action: r.get(0)?,
            detail: r.get::<_, String>(1).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
            created_at: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Verifica que la persona pueda usarse en la operación y devuelve las rutas de sus referencias.
pub fn authorize(conn: &Connection, person_id: &str, operation: &str) -> AppResult<Vec<String>> {
    let person = get(conn, person_id)?.ok_or_else(|| AppError::Invalid("La persona ya no existe.".into()))?;
    if !person.is_adult {
        return Err(AppError::Invalid(format!("{} no está marcada como mayor de edad.", person.name)));
    }
    let refs: Vec<String> = references(conn, person_id)?.into_iter().map(|r| r.path).collect();
    if refs.is_empty() && needs_identity(operation) {
        return Err(AppError::Invalid(format!("Agrega al menos una foto de referencia de {}.", person.name)));
    }
    Ok(refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let path = std::env::temp_dir().join(format!("aics-persons-{}-{}.db", std::process::id(), new_id()));
        crate::db::open(&path).unwrap()
    }

    #[test]
    fn identity_requires_adult_and_references() {
        let conn = conn();
        let id = create(&conn, "Ana", None, false).unwrap();
        assert!(authorize(&conn, &id, "identity_generate").unwrap_err().to_string().contains("mayor de edad"));

        update(&conn, &id, "Ana", None, Some(true)).unwrap();
        assert!(authorize(&conn, &id, "portrait_retouch").is_ok());
        assert!(authorize(&conn, &id, "identity_generate").unwrap_err().to_string().contains("referencia"));
        add_reference(&conn, &NewReference { person_id: &id, path: "/x/ref.jpg", width: Some(10), height: Some(10), embedding: &[1.0, 0.0], face: &json!({}) }).unwrap();
        assert_eq!(authorize(&conn, &id, "pose_change").unwrap(), vec!["/x/ref.jpg"]);

        let actions: Vec<String> = audit_log(&conn, &id, 20).unwrap().into_iter().map(|a| a.action).collect();
        assert!(actions.contains(&"persona_creada".to_string()) && actions.contains(&"referencia_agregada".to_string()));
    }

    #[test]
    fn cosine_similarity() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }
}
