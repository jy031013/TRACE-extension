from app.notifications import build_summary_message
from app.pricing import calculate_total


def create_order_summary(
    customer_name: str,
    tier: str,
    cart_items: list[tuple[str, int]],
) -> str:
    pricing = calculate_total(cart_items, tier)
    return build_summary_message(customer_name, pricing)
