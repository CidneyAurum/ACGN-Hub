use serde_json::Value;
use sqlx::SqlitePool;

fn sqlite_file_url(path: &std::path::Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or("SQLite 资料库路径不是有效 Unicode，未打开替代资料库")?;
    // SQLx separates query parameters at '?' and percent-decodes the filename.
    // Encode literal '%' first so names such as "100%20小说" stay unchanged;
    // keep Windows drive/UNC separators intact for tauri-plugin-sql's mapper.
    let encoded = path
        .replace('%', "%25")
        .replace('?', "%3F")
        .replace('#', "%23");
    Ok(format!("sqlite:{encoded}"))
}

#[derive(serde::Deserialize)]
pub struct Statement {
    sql: String,
    #[serde(default)]
    values: Vec<Value>,
}

#[tauri::command]
pub fn get_database_url() -> Result<String, String> {
    if let Some(path) = crate::runtime::portable_data_directory()? {
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("创建便携资料库目录失败：{error}"))?;
        sqlite_file_url(&path.join("acgn-hub.db"))
    } else {
        Ok("sqlite:acgn-hub.db".to_string())
    }
}

fn validate(statement: &Statement) -> Result<(), String> {
    if statement.sql.len() > 32_768
        || statement.values.len() > 256
        || statement.sql.contains(';')
        || statement.sql.contains("--")
        || statement.sql.contains("/*")
    {
        return Err("事务语句过大或包含不允许的 SQL 结构".to_string());
    }
    let words: Vec<_> = statement.sql.split_whitespace().take(3).collect();
    let table = match words.as_slice() {
        [verb, into, table]
            if verb.eq_ignore_ascii_case("INSERT") && into.eq_ignore_ascii_case("INTO") =>
        {
            *table
        }
        [verb, from, table]
            if verb.eq_ignore_ascii_case("DELETE") && from.eq_ignore_ascii_case("FROM") =>
        {
            *table
        }
        [verb, table, _] if verb.eq_ignore_ascii_case("UPDATE") => *table,
        _ => return Err("事务仅允许应用数据表的 INSERT、UPDATE 或 DELETE".to_string()),
    };
    let table = table.split('(').next().unwrap_or_default();
    if !matches!(
        table,
        "download_tasks"
            | "media"
            | "external_ids"
            | "source_items"
            | "resources"
            | "source_configs"
            | "source_diagnostics"
            | "local_files"
            | "organization_history"
            | "game_installs"
            | "plugin_manifests"
    ) {
        return Err("事务目标不是应用数据表".to_string());
    }
    if statement
        .values
        .iter()
        .any(|value| value.is_array() || value.is_object())
    {
        return Err("事务绑定参数只接受 null、布尔值、数字和字符串".to_string());
    }
    Ok(())
}

async fn execute(pool: &SqlitePool, statements: &[Statement]) -> Result<Vec<u64>, String> {
    if statements.is_empty() {
        return Ok(Vec::new());
    }
    if statements.len() > 25_000 {
        return Err("单次事务超过 25000 条语句".to_string());
    }
    for statement in statements {
        validate(statement)?;
    }
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("开始数据库事务失败：{error}"))?;
    let mut affected = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
        let mut query = sqlx::query(&statement.sql);
        for value in &statement.values {
            query = match value {
                Value::Null => query.bind(None::<String>),
                Value::Bool(value) => query.bind(*value),
                Value::Number(value) if value.is_i64() => query.bind(value.as_i64().unwrap()),
                Value::Number(value) if value.is_u64() => query.bind(
                    i64::try_from(value.as_u64().unwrap()).map_err(|_| "数据库整数超过范围")?,
                ),
                Value::Number(value) => query.bind(value.as_f64().ok_or("数据库数字无效")?),
                Value::String(value) => query.bind(value),
                _ => unreachable!("validated scalar value"),
            };
        }
        match query.execute(&mut *transaction).await {
            Ok(result) => affected.push(result.rows_affected()),
            Err(error) => {
                let _ = transaction.rollback().await;
                return Err(format!(
                    "数据库事务第 {} 条语句失败，已回滚：{error}",
                    index + 1
                ));
            }
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("提交数据库事务失败：{error}"))?;
    Ok(affected)
}

#[tauri::command]
pub async fn database_transaction(
    instances: tauri::State<'_, tauri_plugin_sql::DbInstances>,
    statements: Vec<Statement>,
) -> Result<Vec<u64>, String> {
    // Reuse the plugin's exact database pool, but hold one acquired connection for the transaction.
    let pool = instances
        .0
        .read()
        .await
        .get(&get_database_url()?)
        .map(|pool| match pool {
            tauri_plugin_sql::DbPool::Sqlite(pool) => pool.clone(),
        })
        .ok_or("应用 SQLite 数据库尚未初始化")?;
    execute(&pool, &statements).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_file_urls_round_trip_literal_escapes_unicode_and_windows_prefixes() {
        for filename in [
            r"D:\100%20小说 #完整\Data\acgn-hub.db",
            r"D:\literal%FF和%E4\Data\acgn-hub.db",
            r"\\?\D:\便携%20资料\Data\acgn-hub.db",
            r"\\server\share\小说%20收藏#1\Data\acgn-hub.db",
            r"\\?\UNC\server\share\便携%FF\Data\acgn-hub.db",
        ] {
            let path = std::path::Path::new(filename);
            let url = sqlite_file_url(path).unwrap();
            let options: sqlx::sqlite::SqliteConnectOptions = url.parse().unwrap();
            assert_eq!(options.get_filename(), path, "{url}");
            // tauri-plugin-sql appends the URL's path to app_config_dir before
            // passing it to SQLx. Absolute Windows prefixes must survive that.
            #[cfg(windows)]
            {
                let mut mapped = std::path::PathBuf::from(r"C:\Unrelated\Config");
                mapped.push(url.strip_prefix("sqlite:").unwrap());
                let mapped_url = format!("sqlite:{}", mapped.to_str().unwrap());
                let options: sqlx::sqlite::SqliteConnectOptions = mapped_url.parse().unwrap();
                assert_eq!(options.get_filename(), path, "{mapped_url}");
            }
        }
    }

    #[tokio::test]
    async fn encoded_url_reopens_the_existing_literal_percent_database() {
        let root = std::env::temp_dir().join(format!(
            "acgn-sqlite-uri-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let directory = root.join("100%20小说#完整版");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("acgn-hub.db");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE media (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media VALUES ('preserved-id')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&sqlite_file_url(&path).unwrap())
            .await
            .unwrap();
        let (id,): (String,) = sqlx::query_as("SELECT id FROM media")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(id, "preserved-id");
        pool.close().await;
        assert!(!root.join("100 小说#完整版").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn transaction_rolls_back_all_writes_when_second_statement_fails() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE media (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        let statements = vec![
            Statement {
                sql: "INSERT INTO media (id, title) VALUES (?, ?)".into(),
                values: vec![Value::String("one".into()), Value::String("title".into())],
            },
            Statement {
                sql: "INSERT INTO media (id, title) VALUES (?, ?)".into(),
                values: vec![
                    Value::String("one".into()),
                    Value::String("duplicate".into()),
                ],
            },
        ];
        assert!(execute(&pool, &statements).await.is_err());
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
        execute(&pool, &statements[..1]).await.unwrap();
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
        pool.close().await;
    }
    #[test]
    fn transaction_rejects_schema_and_multiple_statements() {
        for sql in [
            "DROP TABLE media",
            "DELETE FROM media; DROP TABLE media",
            "DELETE FROM secrets",
            "ATTACH DATABASE ? AS other",
        ] {
            assert!(validate(&Statement {
                sql: sql.into(),
                values: vec![]
            })
            .is_err());
        }
    }

    #[tokio::test]
    async fn transaction_reports_actual_rows_for_conflict_ignores() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE media (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        let statement = Statement {
            sql: "INSERT INTO media (id, title) VALUES (?, ?) ON CONFLICT DO NOTHING".into(),
            values: vec![Value::String("same".into()), Value::String("keep".into())],
        };
        assert_eq!(
            execute(&pool, std::slice::from_ref(&statement))
                .await
                .unwrap(),
            vec![1]
        );
        assert_eq!(
            execute(&pool, std::slice::from_ref(&statement))
                .await
                .unwrap(),
            vec![0]
        );
        pool.close().await;
    }
}
