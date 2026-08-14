from tools import _POOL,mysql,make_json_safe
import re

conn= cursor =None
def list_tables():
    try:
        conn = _POOL.get_connection()
        cursor = conn.cursor(dictionary=True, buffered=True)
        cursor.execute("SHOW TABLES")
        TABLES = [list(row.values())[0] for row in cursor.fetchall()]
        print(f"Tables: -- {TABLES}")
        return {"success": True, "tables": TABLES}
    except Exception as e:
        return {"error":str(e)}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()

def describe_table(tablename: str):
    if not re.match(r"^[A-Za-z0-9_]+$", tablename):
        return {"error": "Invalid table name"}
    conn = cursor = None
    try:
        conn = _POOL.get_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(f"DESCRIBE {tablename}")
        columns = cursor.fetchall()
        print("Description of the table: -", columns)
        return {"success": True, "columns": columns}
    except Exception as e:
        print(f"Error: - {str(e)}")
        return {"error": str(e)}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()

def sample_table(tablename: str, limit: int = 5):
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
        print(f"TABLE ROWS ___: - {make_json_safe(rows)}")
        return {"success": True, "table": tablename, "rows": make_json_safe(rows)}
    except mysql.connector.Error as e:
        return {"success": False, "error": str(e)}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()
list_tables()
describe_table("florida_sales")
sample_table("florida_sales")

