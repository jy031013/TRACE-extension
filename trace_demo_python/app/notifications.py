def build_summary_message(customer_name: str, pricing: dict) -> str:
    return (
        f"Order for {customer_name}: "
        f"subtotal=${pricing['subtotal']:.2f}, "
        f"discount=${pricing['discount']:.2f}, "
        f"tax=${pricing['tax']:.2f}, "
        f"delivery=${pricing['delivery_fee']:.2f}, "
        f"total=${pricing['total']:.2f}"
    )
