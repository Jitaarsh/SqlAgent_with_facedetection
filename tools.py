import os
import mysql.connector
from mysql.connector import pooling
import re
from decimal import Decimal
from dotenv import load_dotenv

load_dotenv()

ALLOWED_TABLES = {"customers", "month_data", "products"}

_FIXED_SESSION_ID = "persistent-session"

_POOL = pooling.MySQLConnectionPool(
    pool_name="main_pool",
    pool_size=5,
    host=os.getenv("MYSQL_HOST"),
    port=int(os.getenv("MYSQL_PORT", 3306)),
    user=os.getenv("MYSQL_USER"),
    password=os.getenv("MYSQL_PASSWORD"),
    database=os.getenv("MYSQL_DATABASE"),
    connection_timeout=5,
)

_SESSIONS = {_FIXED_SESSION_ID: _POOL}


def make_json_safe(obj):
    if isinstance(obj, list):
        return [make_json_safe(i) for i in obj]
    elif isinstance(obj, dict):
        return {k: make_json_safe(v) for k, v in obj.items()}
    elif isinstance(obj, Decimal):
        return float(obj)
    elif hasattr(obj, "isoformat"):
        return obj.isoformat()
    return obj


def connect_to_mysql():
    print("[tools] connect_to_mysql → returning cached session")
    return {
        "success": True,
        "session_id": _FIXED_SESSION_ID,
        "message": f"Connected to database '{os.getenv('MYSQL_DATABASE')}'"
    }


def _is_select_only(query: str) -> bool:
    cleaned = re.sub(r"--.*?$|/\*.*?\*/", "", query, flags=re.MULTILINE | re.DOTALL).strip()
    if not cleaned:
        return False
    if ";" in cleaned.rstrip(";"):
        return False
    if not re.match(r"^(SELECT|WITH)\s", cleaned, re.IGNORECASE):
        return False
    forbidden = r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|REPLACE|LOCK|CALL|EXEC)\b"
    if re.search(forbidden, cleaned, re.IGNORECASE):
        return False
    return True


def _strip_limit(query: str) -> str:
    """Remove any trailing LIMIT clause the LLM may have added.
    This ensures we always fetch all matching rows from the database.
    """
    # Remove LIMIT N or LIMIT N, M (with optional semicolon)
    stripped = re.sub(
        r"\bLIMIT\s+\d+(?:\s*,\s*\d+)?\s*;?\s*$",
        "",
        query.rstrip(),
        flags=re.IGNORECASE,
    ).rstrip().rstrip(";")
    if stripped != query.rstrip():
        print(f"[tools] LIMIT clause stripped from query.")
    return stripped


def list_tables():
    print("[tools] list_tables → returning cached session")
    conn = cursor = None
    try:
        conn = _POOL.get_connection()
        cursor = conn.cursor(dictionary=True, buffered=True)
        cursor.execute("SHOW TABLES")
        tables = [list(row.values())[0] for row in cursor.fetchall() if list(row.values())[0] in ALLOWED_TABLES]
        return {"success": True, "tables": tables}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if cursor: cursor.close()
        if conn: conn.close()


def describe_table(tablename: str):
    print("[tools] describe_table → returning cached session")
    if tablename not in ALLOWED_TABLES:
        return {"success": False, "error": f"Table '{tablename}' is not accessible."}
    if not re.match(r"^[A-Za-z0-9_]+$", tablename):
        return {"error": "Invalid table name"}
    conn = cursor = None
    try:
        conn = _POOL.get_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(f"DESCRIBE {tablename}")
        columns = cursor.fetchall()
        return {"success": True, "columns": columns}
    except Exception as e:
        print(f"Error: - {str(e)}")
        return {"error": str(e)}
    finally:
        if cursor: cursor.close()
        if conn: conn.close()


def sample_table(tablename: str, limit: int = 5):
    print("[tools] sample_table → returning cached session")
    if tablename not in ALLOWED_TABLES:
        return {"success": False, "error": f"Table '{tablename}' is not accessible."}
    if not re.match(r"^[A-Za-z0-9_]+$", tablename):
        return {"success": False, "error": "Invalid table name"}
    try:
        limit = max(1, min(int(limit), 100))
    except (TypeError, ValueError):
        limit = 5
    conn = cursor = None
    try:
        conn = _POOL.get_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(f"SELECT * FROM `{tablename}` LIMIT {limit}")
        rows = cursor.fetchall()
        return {"success": True, "table": tablename, "rows": make_json_safe(rows)}
    except mysql.connector.Error as e:
        return {"success": False, "error": str(e)}
    finally:
        if cursor: cursor.close()
        if conn: conn.close()


def get_metadata(tablename: str):
    print("[tools] get_metadata → returning cached session")
    if tablename not in ALLOWED_TABLES:
        return {"success": False, "error": f"Table '{tablename}' is not accessible."}
    if not re.match(r"^[A-Za-z0-9_]+$", tablename):
        return {"success": False, "error": "Invalid table name"}
    conn = cursor = None
    try:
        conn = _POOL.get_connection()
        cursor = conn.cursor(dictionary=True, buffered=True)
        cursor.execute("""
            SELECT TABLE_ROWS   AS row_count,
                   DATA_LENGTH  AS data_bytes,
                   ENGINE       AS engine,
                   CREATE_TIME  AS created,
                   UPDATE_TIME  AS updated
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = %s
        """, (tablename,))
        meta = cursor.fetchone()
        if not meta:
            return {"success": False, "error": f"Table '{tablename}' not found"}
        return {"success": True, "table": tablename, "metadata": make_json_safe(meta)}
    except mysql.connector.Error as e:
        return {"success": False, "error": str(e)}
    finally:
        if cursor: cursor.close()
        if conn: conn.close()


def run_select_query(query: str, session_id: str = None):
    # Strip any LIMIT clause the LLM may have injected
    query = _strip_limit(query)
    print(f"[tools] run_select_query: {query[:80]}...")
    if not session_id or session_id not in _SESSIONS:
        return {"success": False, "error": "Invalid or missing session_id"}
    if not _is_select_only(query):
        return {"success": False, "error": "Forbidden query type"}

    # Block queries referencing tables outside ALLOWED_TABLES
    found = re.findall(r'\bFROM\s+`?(\w+)`?|\bJOIN\s+`?(\w+)`?', query, re.IGNORECASE)
    used = {t for pair in found for t in pair if t}
    forbidden = used - ALLOWED_TABLES
    if forbidden:
        return {"success": False, "error": f"Tables not allowed: {forbidden}"}

    pool = _SESSIONS[session_id]
    conn = cursor = None
    try:
        conn = pool.get_connection()
        cursor = conn.cursor(dictionary=True)
        try:
            while conn.next_result():
                pass
        except:
            pass
        cursor.execute(query)
        rows = cursor.fetchall()
        return {
            "success": True,
            "row_count": len(rows),
            "rows": make_json_safe(rows),
        }
    except mysql.connector.Error as e:
        return {"success": False, "error": str(e)}
    finally:
        if cursor: cursor.close()
        if conn: conn.close()