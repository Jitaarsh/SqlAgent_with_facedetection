from dotenv import load_dotenv
import os
load_dotenv()
url = os.getenv("url")

import requests
import json
import re
import threading
import queue

from tools import connect_to_mysql, run_select_query, list_tables, describe_table, sample_table, get_metadata

AVAILABLE_FUNCTIONS = {
    "connect_to_mysql": connect_to_mysql,
    "run_select_query": run_select_query,
    "list_tables":      list_tables,
    "describe_table":   describe_table,
    "sample_rows":      sample_table,
    "get_metadata":     get_metadata,
}

_SCHEMA_CACHE = {}

# ─────────────────────────────────────────────────────────────
# TOKEN BUDGETS
# ─────────────────────────────────────────────────────────────
_TOKENS_TOOL_DISPATCH  = 512    # connect / list / describe / sample — only needs next TOOL_CALL line
_TOKENS_QUERY_DISPATCH = 2048   # run_select_query planning turn
_TOKENS_FINAL          = 4096   # final FINAL: block (prose only, not the table)
_TOKENS_SUMMARY        = 300

# ─────────────────────────────────────────────────────────────
# SYSTEM PROMPT
# ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """
You are a MySQL query agent for Shankar Distillers' sales database.
Your only job: run SQL and return real data as a markdown table plus a short summary.

══════════════════════════════════════════════════════════
GOLDEN RULES — NEVER BREAK THESE
══════════════════════════════════════════════════════════

1. NEVER answer from memory. NEVER invent data. NEVER guess column names.
2. ALWAYS call connect_to_mysql FIRST — no exceptions.
3. DO NOT rediscover schema with tools. The schema is preloaded in the first user message.
4. ALWAYS use run_select_query to get real rows before FINAL.
5. ONLY use SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER.
5a. NEVER add a LIMIT clause to your queries. Always fetch ALL matching rows.
6. NEVER write FINAL until you have real TOOL_RESULT rows in hand.
7. After run_select_query returns rows, write ONLY:
   FINAL: <one sentence confirming rows were found>
   Do NOT repeat the table — the system sends it directly.
8. BEFORE writing any SQL, read the SCHEMA CONTEXT in the first message carefully.
9. Sample rows are provided for every table — use them to identify the correct column.
   e.g. if user asks for "city", find which column in sample rows contains city names.
10. NEVER assume a column name maps to what the user asked for — verify from sample data.

══════════════════════════════════════════════════════════
TOOL CALL FORMAT — USE EXACTLY THIS FORMAT
══════════════════════════════════════════════════════════

TOOL_CALL: connect_to_mysql
ARGS: {}

TOOL_CALL: list_tables
ARGS: {}

TOOL_CALL: describe_table
ARGS: {"tablename": "<table>"}

TOOL_CALL: sample_rows
ARGS: {"tablename": "<table>", "limit": 5}

TOOL_CALL: get_metadata
ARGS: {"tablename": "<table>"}

TOOL_CALL: run_select_query
ARGS: {"session_id": "<from connect_to_mysql result>", "query": "SELECT ..."}

══════════════════════════════════════════════════════════
DATABASE STRUCTURE
══════════════════════════════════════════════════════════


These are related via foreign keys — always JOIN them, never UNION ALL.
MANDATORY: Call describe_table AND sample_rows on ALL 3 tables before writing any SQL.
Read the actual sample data to identify which column truly contains city names.

Base JOIN pattern (replace col names with real ones from describe_table):
SELECT m.date_col, c.id_col, c.name_col, p.name_col, m.cases_col
FROM month_data m
JOIN customers c ON m.customer_fk = c.customer_pk
JOIN products p ON m.product_fk = p.product_pk

══════════════════════════════════════════════════════════
SPECIAL QUERY FORMATS
══════════════════════════════════════════════════════════

Use ONLY when user message contains the EXACT trigger phrase.
Always JOIN all 3 tables. Use REAL column names from describe_table/sample_rows.


══════════════════════════════════════════════════════════
AGGREGATION QUERIES
══════════════════════════════════════════════════════════

When user asks "how many", "count", "total", "sum", "average" → use aggregation.
Never return raw rows for counting questions.

COLUMN IDENTIFICATION RULE:
The schema context contains sample rows for every table.
Before using any column, check what the sample rows actually contain.
If user asks for "city" → find the column whose sample values look like city names.
If user asks for "product name" → find the column with product name values.
Do NOT rely on column names alone — read the sample values.

ADDRESS PARSING RULE:
If the user asks for city names but the table only has a full address column,
extract the city using SQL string functions — do NOT return the full address.

Example pattern (adapt to real column names and address format from sample_rows):
If sample_rows shows addresses like "STORE NAME, 123 STREET, CITY, STATE, ZIP"
then extract city with: TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(address_col, ',', -3), ',', 1))

Always verify the format from sample_rows first, then pick the correct substring position.

══════════════════════════════════════════════════════════
OUTPUT FORMAT
══════════════════════════════════════════════════════════

After run_select_query returns TOOL_RESULT with rows, output ONLY:

FINAL: Query returned N rows successfully.

The system will handle sending the actual table — do NOT reproduce the rows.
If result is empty → FINAL: No rows returned for this query.
If tool returns error → fix SQL and call run_select_query again.
"""

# ─────────────────────────────────────────────────────────────
# SUMMARY PROMPT
# ─────────────────────────────────────────────────────────────
SUMMARY_PROMPT = """You are a concise business analyst for Shankar Distillers.
You will be given a markdown table of sales data and the user's original question.
Write exactly 2-3 sentences that:
1. State what the data shows directly (reference the actual numbers from the table)
2. Call out the single most notable pattern or outlier
3. State what it means for the business

Rules:
- Only reference numbers that appear in the table — never invent figures
- No preamble like "The table shows..." — start with the insight directly
- No bullet points, no headers — plain prose only
- Do not mention SQL, databases, or tools
"""

# ─────────────────────────────────────────────────────────────
# SHARED HELPERS
# ─────────────────────────────────────────────────────────────


SECTION_FORMAT_FILES = {
    "Retail Purchases": "formats/Retail purchases.txt",
    "Order History": "formats/Order History.txt",
    "Reorder Frequency": "formats/Reorder Frequency.txt",
    "New Retailer": "formats/New Retailer.txt",
    "Top Accounts": "formats/Top Accounts.txt",
    "Top Accounts Comparison": "formats/Top Accounts Comparison.txt",
    "Custom": None,
}

def load_format_instructions(section: str) -> str:
    path = SECTION_FORMAT_FILES.get(section)
    if not path or not os.path.exists(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()

headers = {'Content-Type': 'application/json'}

TOOL_CALL_PATTERN = re.compile(
    r"TOOL_CALL:\s*(\w+)\s*\n\s*ARGS:\s*(\{.*?\})",
    re.DOTALL
)

# How many rows to sample for the summary (don't feed all 27K to summariser)
_SUMMARY_SAMPLE_ROWS = 50
_CHUNK_SIZE = 8192   # bytes per SSE chunk for table streaming


def build_markdown_table(result: dict) -> str:
    rows = result.get("rows", [])
    if not rows:
        return "| result |\n|---|\n| No rows returned |"
    columns = list(rows[0].keys())
    header = "| " + " | ".join(columns) + " |"
    sep    = "| " + " | ".join("---" for _ in columns) + " |"
    lines  = [header, sep]
    for row in rows:
        lines.append(
            "| " + " | ".join(
                str(row.get(c)) if row.get(c) is not None else ""
                for c in columns
            ) + " |"
        )
    return "\n".join(lines)


def _has_real_rows(result: dict) -> bool:
    rows = result.get("rows", [])
    return bool(rows and isinstance(rows[0], dict))


def _is_query_success(result: dict) -> bool:
    return result.get("success") is True and not result.get("error")


def build_tool_result_message(fn_name: str, result: dict, fn_args: dict = None) -> str:
    """
    CRITICAL: For run_select_query we NO LONGER embed the raw rows in the
    message back to the LLM.  Feeding 27K rows of JSON back into the context
    is the single biggest cause of slowness — the LLM has to tokenise and
    attend over MBs of data before it can produce FINAL.
    Instead we tell it the row count and that the table is handled externally.
    """
    if fn_name == "connect_to_mysql":
        if result.get("success"):
            sid = result.get("session_id", "")
            return (
                f"TOOL_RESULT: connected. session_id = {sid}\n"
                f"Now call list_tables to see what tables exist."
            )
        return f"TOOL_RESULT: connection failed: {result.get('error')}. Try connect_to_mysql again."

    if fn_name == "list_tables":
        if result.get("success"):
            tables = result.get("tables", [])
            return (
                f"TOOL_RESULT: found {len(tables)} tables: {', '.join(tables)}\n"
                f"Now call describe_table for the relevant table(s)."
            )
        return f"TOOL_RESULT: list_tables failed: {result.get('error')}"

    if fn_name == "describe_table":
        if result.get("success"):
            cols = result.get("columns", [])
            col_summary = ", ".join(f"{c['Field']} ({c['Type']})" for c in cols)
            return (
                f"TOOL_RESULT: columns for {(fn_args or {}).get('tablename', 'table')}: {col_summary}\n"
                f"Now call sample_rows to see real data values before writing SQL."
            )
        return f"TOOL_RESULT: describe_table failed: {result.get('error')}"

    if fn_name == "sample_rows":
        if result.get("success"):
            rows = result.get("rows", [])
            return (
                f"TOOL_RESULT: sample of {len(rows)} rows from {result.get('table', 'table')}:\n"
                f"{json.dumps(rows, default=str)}\n"
                f"You now have real column names and values for this table.\n"
                f"IMPORTANT: Look for foreign key columns (columns ending in _id or referencing another table). "
                f"If you see any, call describe_table and sample_rows on those referenced tables too before writing SQL. "
                f"JOIN all related tables using their foreign keys to get complete data — never leave name columns empty."
            )
        return f"TOOL_RESULT: sample_rows failed: {result.get('error')}"

    if fn_name == "get_metadata":
        if result.get("success"):
            meta = result.get("metadata", {})
            return (
                f"TOOL_RESULT: metadata for {result.get('table')}: "
                f"~{meta.get('row_count')} rows, engine={meta.get('engine')}\n"
                f"Proceed with run_select_query."
            )
        return f"TOOL_RESULT: get_metadata failed: {result.get('error')}"

    if fn_name == "run_select_query":
        if not _is_query_success(result):
            error      = result.get("error", "unknown error")
            last_query = (fn_args or {}).get("query", "")
            return (
                f"TOOL_RESULT: query failed: {error}\n"
                f"Failed query:\n{last_query}\n"
                f"Fix the SQL and call run_select_query again."
            )
        if not _has_real_rows(result):
            last_query = (fn_args or {}).get("query", "")
            return (
                f"TOOL_RESULT: query returned 0 rows.\n"
                f"Query was:\n{last_query}\n"
                f"Check WHERE clause values against sample_rows results and retry."
            )
        # ← KEY CHANGE: only report row count, not the actual data
        row_count = len(result.get("rows", []))
        return (
            f"TOOL_RESULT: query succeeded. Got {row_count} rows.\n"
            f"The table will be sent to the user directly by the system.\n"
            f"Write: FINAL: Query returned {row_count} rows successfully."
        )

    return f"TOOL_RESULT for {fn_name}: {json.dumps(result, default=str)}"


def _describe_columns(columns: list[dict]) -> str:
    return ", ".join(f"{c['Field']} {c['Type']}" for c in columns)


def _format_sample_rows(rows: list[dict]) -> str:
    if not rows:
        return "[]"
    return json.dumps(rows, default=str)


def _get_or_build_schema() -> str:
    if _SCHEMA_CACHE.get("schema"):
        return _SCHEMA_CACHE["schema"]

    schema_lines = [
        "SCHEMA CONTEXT: The database schema is fixed and may be used directly. Do not rediscover schema with tools.",
    ]

    connect_result = connect_to_mysql()
    tables = []
    if connect_result.get("success"):
        list_result = list_tables()
        tables = list_result.get("tables", []) if list_result.get("success") else []

    if not tables:
        tables = ["customers", "month_data", "products"]

    schema_lines.append("Tables: " + ", ".join(tables))

    for table in tables:
        describe_result = describe_table(table)
        if describe_result.get("success"):
            schema_lines.append(
                f"{table}: {_describe_columns(describe_result.get('columns', []))}."
            )
        sample_result = sample_table(table, limit=5)
        if sample_result.get("success"):
            schema_lines.append(
                f"Sample {table}: {_format_sample_rows(sample_result.get('rows', []))}."
            )

    schema_text = "\n".join(schema_lines)
    _SCHEMA_CACHE["schema"] = schema_text
    return schema_text


def _dispatch(fn_name: str, fn_args: dict):
    fn = AVAILABLE_FUNCTIONS.get(fn_name)
    if fn is None:
        return {"success": False, "error": f"Unknown tool: {fn_name}"}
    try:
        return fn(**fn_args)
    except Exception as e:
        return {"success": False, "error": str(e)}


def _parse_args(args_str: str) -> tuple[dict, Exception | None]:
    try:
        return json.loads(args_str), None
    except json.JSONDecodeError as e:
        cleaned = re.sub(r'(?<!\\)[\n\r\t]', ' ', args_str)
        try:
            return json.loads(cleaned), None
        except json.JSONDecodeError:
            return {}, e


def _call_llm_sync(messages: list, max_tokens: int) -> str:
    """Non-streaming LLM call — fast for tool-dispatch turns."""
    payload = json.dumps({
        "model": "/root/.cache/huggingface/",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0,
        "ignore_eos": False,
        "stop": ["User:", "<|eot_id|>"]
    })
    response = requests.post(url, headers=headers, data=payload)
    return response.json()["choices"][0]["message"]["content"]


def _stream_table_chunked(table_text: str):
    """
    Yield the markdown table in large chunks rather than char-by-char.
    Newlines are escaped as \\n so each SSE event is a single logical line.
    We send one chunk per SSE event to minimise overhead.
    """
    # Escape newlines once upfront
    escaped = table_text.replace("\n", "\\n")
    # Yield in large chunks — browser buffers these and renders at the end
    for i in range(0, len(escaped), _CHUNK_SIZE):
        yield escaped[i:i + _CHUNK_SIZE]


def get_summary_stream(user_question: str, markdown_table: str):
    """Stream the summary paragraph after the table is sent."""
    # Only feed a sample of rows to the summary model — it doesn't need all 27K
    lines = markdown_table.split("\n")
    # Keep header + separator + first _SUMMARY_SAMPLE_ROWS data rows
    sample_lines = lines[:2 + _SUMMARY_SAMPLE_ROWS]
    sample_table_text = "\n".join(sample_lines)

    payload = json.dumps({
        "model": "/root/.cache/huggingface/",
        "messages": [
            {"role": "system", "content": SUMMARY_PROMPT},
            {"role": "user", "content": f"User question: {user_question}\n\nData (sample):\n{sample_table_text}"}
        ],
        "max_tokens": _TOKENS_SUMMARY,
        "temperature": 0.3,
        "ignore_eos": False,
        "stream": True,
        "stop": ["<|eot_id|>"]
    })
    try:
        resp = requests.post(url, headers=headers, data=payload, stream=True)
        for line in resp.iter_lines():
            if not line:
                continue
            line = line.decode("utf-8")
            if line.startswith("data: "):
                line = line[6:]
            if line == "[DONE]":
                break
            try:
                chunk = json.loads(line)
                delta = chunk["choices"][0]["delta"].get("content", "")
                if delta:
                    yield delta.replace("\n", "\\n")
            except Exception:
                continue
    except Exception:
        return


def _get_summary_queue(user_question: str, markdown_table: str, q: queue.Queue):
    for chunk in get_summary_stream(user_question, markdown_table):
        q.put(chunk)
    q.put(None)


def _yield_table_then_summary(result: dict, user_question: str):
    """
    Build the markdown table, stream it in chunks, then stream the summary.
    This is the hot path for large result sets.
    """
    table = build_markdown_table(result)

    # 1. Send a sentinel so the JS knows a big table is coming (skip live preview)
    yield "__TABLE_START__"

    # 2. Stream the table in chunks
    yield from _stream_table_chunked(table)

    # 3. Sentinel: table done, summary follows
    yield "__TABLE_END__"
    yield "\\n\\n"
    yield "__SUMMARY__"

    # 4. Stream summary (uses only a sample of rows, so it's fast)
    yield from get_summary_stream(user_question, table)


# ─────────────────────────────────────────────────────────────
# NON-STREAMING  (kept for /ask endpoint)
# ─────────────────────────────────────────────────────────────

def call_ai(user_messages, max_turns=25, section="Retail Purchases"):
    schema_context = _get_or_build_schema()
    format_instructions = load_format_instructions(section)
    dynamic_prompt = (
        f"SECTION LOCK: {section}\n"
        f"You are LOCKED to the '{section}' section.\n"
        f"Before doing ANYTHING else, check if the user's query is related to '{section}'.\n"
        f"If it is NOT related, respond ONLY with:\n"
        f"'This query is outside the {section} section. Please switch to the relevant option in the sidebar.'\n"
        f"Do NOT call any tools. Do NOT connect to MySQL. Just return that one line and stop.\n\n"
        f"{format_instructions}\n\n"
        + SYSTEM_PROMPT
    )
    messages = [
        {"role": "system", "content": dynamic_prompt},
        {"role": "user",   "content": schema_context},
    ] + user_messages
    query_executed   = False
    last_tool_result = None

    for turn in range(max_turns):
        max_tok = _TOKENS_FINAL if query_executed else _TOKENS_TOOL_DISPATCH
        content = _call_llm_sync(messages, max_tok)
        print(f"[call_ai turn {turn}] max_tok={max_tok} content[:200]: {content[:200]}")

        match = TOOL_CALL_PATTERN.search(content)

        if not match:
            if not query_executed:
                messages.append({"role": "assistant", "content": content})
                messages.append({
                    "role": "user",
                    "content": "You must call tools before answering. Start with:\nTOOL_CALL: connect_to_mysql\nARGS: {}"
                })
                continue
            if last_tool_result is not None:
                table = build_markdown_table(last_tool_result)
                user_question = next((m["content"] for m in reversed(user_messages) if m["role"] == "user"), "")
                # non-streaming summary for this path
                sample_lines = table.split("\n")[:2 + _SUMMARY_SAMPLE_ROWS]
                summary_payload = json.dumps({
                    "model": "/root/.cache/huggingface/",
                    "messages": [
                        {"role": "system", "content": SUMMARY_PROMPT},
                        {"role": "user", "content": f"User question: {user_question}\n\nData (sample):\n{chr(10).join(sample_lines)}"}
                    ],
                    "max_tokens": _TOKENS_SUMMARY,
                    "temperature": 0.3,
                    "ignore_eos": False,
                    "stop": ["<|eot_id|>"]
                })
                try:
                    resp = requests.post(url, headers=headers, data=summary_payload)
                    summary = resp.json()["choices"][0]["message"]["content"].strip()
                except Exception:
                    summary = ""
                return table + ("\n\n" + summary if summary else ""), messages
            final_text = content.replace("FINAL:", "").strip()
            return final_text, messages

        fn_name  = match.group(1)
        args_str = match.group(2)
        fn_args, parse_err = _parse_args(args_str)
        result = {"success": False, "error": f"Could not parse ARGS: {parse_err}"} if parse_err else _dispatch(fn_name, fn_args)

        print(f"[call_ai] tool={fn_name} result_keys={list(result.keys())}")

        if fn_name == "run_select_query":
            query_executed = True
            if _is_query_success(result) and _has_real_rows(result):
                last_tool_result = result
                # Don't feed rows back to LLM — just return immediately
                table = build_markdown_table(result)
                user_question = next((m["content"] for m in reversed(user_messages) if m["role"] == "user"), "")
                sample_lines = table.split("\n")[:2 + _SUMMARY_SAMPLE_ROWS]
                summary_payload = json.dumps({
                    "model": "/root/.cache/huggingface/",
                    "messages": [
                        {"role": "system", "content": SUMMARY_PROMPT},
                        {"role": "user", "content": f"User question: {user_question}\n\nData (sample):\n{chr(10).join(sample_lines)}"}
                    ],
                    "max_tokens": _TOKENS_SUMMARY,
                    "temperature": 0.3,
                    "ignore_eos": False,
                    "stop": ["<|eot_id|>"]
                })
                try:
                    resp = requests.post(url, headers=headers, data=summary_payload)
                    summary = resp.json()["choices"][0]["message"]["content"].strip()
                except Exception:
                    summary = ""
                return table + ("\n\n" + summary if summary else ""), messages

        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": build_tool_result_message(fn_name, result, fn_args)})

    if last_tool_result:
        return build_markdown_table(last_tool_result), messages
    return "Max turns reached without a final answer.", messages


# ─────────────────────────────────────────────────────────────
# STREAMING  ← primary path
# ─────────────────────────────────────────────────────────────

def call_ai_stream(user_messages, max_turns=25, stop_event=None, section="Retail Purchases"):
    schema_context = _get_or_build_schema()
    format_instructions = load_format_instructions(section)
    dynamic_prompt = SYSTEM_PROMPT + (
        f"\n\nCURRENT SECTION: {section}\n"
        f"ONLY answer questions related to '{section}'. "
        f"If the user asks about a different topic, respond: "
        f"'Please switch to the relevant option in the sidebar.'\n\n"
        f"FORMAT INSTRUCTIONS:\n{format_instructions}"
        if format_instructions else
        f"\n\nCURRENT SECTION: Custom — no format restrictions."
    )
    messages = [
        {"role": "system", "content": dynamic_prompt},
        {"role": "user",   "content": schema_context},
    ] + user_messages
    last_query       = None
    repeated_count   = 0
    last_tool_result = None
    query_executed   = False

    user_question = next((m["content"] for m in reversed(user_messages) if m["role"] == "user"), "")

    for turn in range(max_turns):
        if stop_event and stop_event.is_set():
            return

        # ── All intermediate tool-dispatch turns: non-streaming, tight budget ──
        content = _call_llm_sync(messages, _TOKENS_QUERY_DISPATCH if not query_executed else _TOKENS_FINAL)
        print(f"[stream turn {turn}] query_executed={query_executed} content[:150]={content[:150]}")

        match = TOOL_CALL_PATTERN.search(content)

        # ── No tool call found ────────────────────────────────────────────────
        if not match:
            if not query_executed:
                # Check if LLM returned a section lock rejection
                if "Please switch to the relevant option in the sidebar" in content:
                    for char in content:
                        yield char if char != "\n" else "\\n"
                    return
                messages.append({"role": "assistant", "content": content})
                messages.append({
                    "role": "user",
                    "content": "You must call tools first. Do not answer from memory.\nTOOL_CALL: connect_to_mysql\nARGS: {}"
                })
                continue

            # Model wrote FINAL without a tool call after query — that's fine,
            # serve whatever last result we have
            if last_tool_result is not None:
                yield from _yield_table_then_summary(last_tool_result, user_question)
            else:
                for char in content:
                    yield char if char != "\n" else "\\n"
            return

        # ── Tool call found ───────────────────────────────────────────────────
        fn_name  = match.group(1)
        args_str = match.group(2)

        # Emit status token
        STATUS = {
            "connect_to_mysql": "Connecting to database...",
            "list_tables":      "Listing tables...",
            "describe_table":   "Describing table...",
            "sample_rows":      "Sampling rows...",
            "run_select_query": "Running query...",
            "get_metadata":     "Getting metadata...",
        }
        if fn_name in STATUS:
            yield f"__STATUS__{STATUS[fn_name]}__STATUS__"

        fn_args, parse_err = _parse_args(args_str)
        result = {"success": False, "error": f"Could not parse ARGS: {parse_err}"} if parse_err else _dispatch(fn_name, fn_args)

        print(f"[stream] tool={fn_name} success={result.get('success')} error={result.get('error','')}")

        # ── run_select_query: the hot path ────────────────────────────────────
        if fn_name == "run_select_query":
            current_query = fn_args.get("query", "")
            if current_query == last_query:
                repeated_count += 1
            else:
                repeated_count = 0
                last_query = current_query

            if _is_query_success(result) and _has_real_rows(result):
                last_tool_result = result
                # ← Stream table + summary immediately, no extra LLM round-trip
                print(f"[DEBUG] rows fetched: {len(result.get('rows', []))}")
                print(f"[DEBUG] query: {fn_args.get('query', '')}")
                yield from _yield_table_then_summary(result, user_question)
                return

            if _is_query_success(result) and not _has_real_rows(result):
                last_tool_result = None

            if repeated_count >= 1 and last_tool_result is not None:
                yield from _yield_table_then_summary(last_tool_result, user_question)
                return

            # Query failed or 0 rows — let model retry
            query_executed = False
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": build_tool_result_message(fn_name, result, fn_args)})
            continue

        # ── All other tools ───────────────────────────────────────────────────
        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": build_tool_result_message(fn_name, result, fn_args)})

    # Hard fallback
    if last_tool_result is not None:
        yield from _yield_table_then_summary(last_tool_result, user_question)
    else:
        yield "Max turns reached without a final answer."