from collections import defaultdict
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class CategoryTotal:
    category: str
    total_cents: int
    count: int

    @property
    def average_cents(self) -> int:
        return self.total_cents // self.count

    def as_dict(self) -> dict:
        return {
            "category": self.category,
            "total_cents": self.total_cents,
            "count": self.count,
            "average_cents": self.average_cents,
        }


def in_month(day: date, month: date) -> bool:
    return day.year == month.year and day.month == month.month


def category_totals(transactions, month: date) -> list[CategoryTotal]:
    """Totals per category for one calendar month, largest spend first, then by name."""
    totals: defaultdict[str, int] = defaultdict(int)
    counts: defaultdict[str, int] = defaultdict(int)
    for tx in transactions:
        if not in_month(tx["date"], month):
            continue
        category = tx.get("category") or "uncategorized"
        totals[category] += tx["amount_cents"]
        counts[category] += 1
    summary = [CategoryTotal(category, totals[category], counts[category]) for category in totals]
    return sorted(summary, key=lambda item: (-item.total_cents, item.category))


def monthly_summary(transactions, month: date) -> list[dict]:
    """The dict form that the /reports/monthly endpoint and the CSV export return."""
    return [item.as_dict() for item in category_totals(transactions, month)]


def format_summary(summary: list[dict]) -> str:
    return "\n".join(format_line(item) for item in summary)


def format_line(item: dict) -> str:
    dollars = item["total_cents"] / 100
    return f"{item['category']:<20} {item['count']:>5} {dollars:>12,.2f}"
