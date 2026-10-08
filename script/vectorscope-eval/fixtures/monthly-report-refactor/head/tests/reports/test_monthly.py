from datetime import date

from app.reports.monthly import CategoryTotal, category_totals, format_summary, monthly_summary


def test_monthly_summary_groups_by_category():
    transactions = [
        {"date": date(2026, 3, 2), "category": "food", "amount_cents": 1250},
        {"date": date(2026, 3, 15), "category": "food", "amount_cents": 750},
        {"date": date(2026, 3, 20), "category": "rent", "amount_cents": 150000},
        {"date": date(2026, 2, 28), "category": "food", "amount_cents": 999},
    ]
    assert monthly_summary(transactions, date(2026, 3, 1)) == [
        {"category": "rent", "total_cents": 150000, "count": 1, "average_cents": 150000},
        {"category": "food", "total_cents": 2000, "count": 2, "average_cents": 1000},
    ]


def test_category_totals_breaks_ties_by_name():
    transactions = [
        {"date": date(2026, 3, 2), "category": "travel", "amount_cents": 1200},
        {"date": date(2026, 3, 9), "category": "food", "amount_cents": 1200},
        {"date": date(2026, 3, 9), "category": None, "amount_cents": 500},
        {"date": date(2026, 4, 1), "category": "food", "amount_cents": 9900},
    ]
    assert category_totals(transactions, date(2026, 3, 1)) == [
        CategoryTotal("food", 1200, 1),
        CategoryTotal("travel", 1200, 1),
        CategoryTotal("uncategorized", 500, 1),
    ]


def test_format_summary_aligns_columns():
    summary = [{"category": "rent", "total_cents": 150000, "count": 1, "average_cents": 150000}]
    assert format_summary(summary) == "rent" + " " * 21 + "1" + " " * 5 + "1,500.00"
