from flask import Blueprint, abort, jsonify, request

from app.auth import current_shop, login_required
from app.db import get_connection
from app.orders import repository

orders = Blueprint("orders", __name__, url_prefix="/api/orders")


def serialize(order: repository.Order) -> dict:
    return {
        "id": order.id,
        "customerEmail": order.customer_email,
        "status": order.status,
        "totalCents": order.total_cents,
        "createdAt": order.created_at.isoformat(),
    }


@orders.get("/")
@login_required
def list_recent():
    with get_connection() as conn:
        recent = repository.recent_orders(conn, current_shop().id)
    return jsonify([serialize(order) for order in recent])


@orders.get("/search")
@login_required
def search():
    query = request.args.get("q", "")
    status = request.args.get("status") or None
    try:
        limit = int(request.args.get("limit", "50"))
    except ValueError:
        abort(400, description="limit must be an integer")
    if limit < 1:
        abort(400, description="limit must be at least 1")
    with get_connection() as conn:
        try:
            results = repository.search_orders(conn, current_shop().id, query, status=status, limit=limit)
        except ValueError as error:
            abort(400, description=str(error))
    return jsonify([serialize(order) for order in results])


@orders.get("/<int:order_id>")
@login_required
def show(order_id: int):
    with get_connection() as conn:
        order = repository.get_order(conn, current_shop().id, order_id)
    if order is None:
        abort(404)
    return jsonify(serialize(order))
