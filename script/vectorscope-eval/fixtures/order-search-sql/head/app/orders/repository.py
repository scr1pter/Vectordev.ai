from dataclasses import dataclass
from datetime import datetime

from app.db import Connection


@dataclass(frozen=True)
class Order:
    id: int
    customer_email: str
    status: str
    total_cents: int
    created_at: datetime


ORDER_COLUMNS = "id, customer_email, status, total_cents, created_at"
SEARCHABLE_STATUSES = frozenset({"pending", "paid", "shipped", "refunded"})
MAX_SEARCH_RESULTS = 200


def get_order(conn: Connection, shop_id: int, order_id: int) -> Order | None:
    row = conn.execute(
        f"SELECT {ORDER_COLUMNS} FROM orders WHERE shop_id = %s AND id = %s",
        (shop_id, order_id),
    ).fetchone()
    return Order(*row) if row else None


def recent_orders(conn: Connection, shop_id: int, limit: int = 20) -> list[Order]:
    rows = conn.execute(
        f"SELECT {ORDER_COLUMNS} FROM orders WHERE shop_id = %s ORDER BY created_at DESC LIMIT %s",
        (shop_id, limit),
    ).fetchall()
    return [Order(*row) for row in rows]


def search_orders(
    conn: Connection,
    shop_id: int,
    query: str,
    status: str | None = None,
    limit: int = 50,
) -> list[Order]:
    """Orders of one shop whose customer email contains `query`, newest first."""
    clauses = ["shop_id = %s"]
    params: list[object] = [shop_id]
    if status is not None:
        if status not in SEARCHABLE_STATUSES:
            raise ValueError(f"unknown status: {status}")
        clauses.append("status = %s")
        params.append(status)
    if query.strip():
        # %% is a literal % once psycopg has filled in the parameters.
        clauses.append("customer_email ILIKE '%%" + query.strip() + "%%'")
    params.append(min(limit, MAX_SEARCH_RESULTS))
    sql = f"SELECT {ORDER_COLUMNS} FROM orders WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT %s"
    return [Order(*row) for row in conn.execute(sql, params).fetchall()]
