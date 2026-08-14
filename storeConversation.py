import os
from dotenv import load_dotenv
import mysql.connector

load_dotenv()

def get_connection():
    return mysql.connector.connect(
        host=os.getenv("MYSQL_HOST"),
        user=os.getenv("MYSQL_USER"),
        password=os.getenv("MYSQL_PASSWORD"),
        database=os.getenv("CONVERSATION_DATABASE")
    )

def get_next_conversation_id(email: str, section: str) -> str:
    section_key = section.lower().replace(" ", "_")
    conn = cursor = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(DISTINCT conversation_id) FROM conversations WHERE email = %s AND conversation_id LIKE %s",
            (email, f"{section_key}_%")
        )
        count = cursor.fetchone()[0]
        return f"{section_key}_{count + 1}"
    finally:
        if cursor: cursor.close()
        if conn: conn.close()

def save_conversation(email: str, conversation_id: str, user_message: str, agent_message: str):
    conn = cursor = None
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO conversations (email, conversation_id, user_message, agent_message) VALUES (%s, %s, %s, %s)",
            (email, conversation_id, user_message, agent_message)
        )
        conn.commit()
    finally:
        if cursor: cursor.close()
        if conn: conn.close()