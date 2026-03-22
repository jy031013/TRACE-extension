from app.catalog import get_product

TAX_RATE = 0.07
DELIVERY_FEE = 5.0


def membership_discount_rate(tier: str) -> float:
    if tier == "member":
        return 0.15
    return 0.0


def calculate_subtotal(cart_items: list[tuple[str, int]]) -> float:
    subtotal = 0.0
    for product_id, quantity in cart_items:
        product = get_product(product_id)
        subtotal += product["price"] * quantity
    return subtotal


def calculate_discount(subtotal: float, tier: str) -> float:
    return subtotal * membership_discount_rate(tier)


def calculate_tax(amount_after_discount: float) -> float:
    return amount_after_discount * TAX_RATE


def calculate_total(cart_items: list[tuple[str, int]], tier: str) -> dict:
    subtotal = calculate_subtotal(cart_items)
    discount = calculate_discount(subtotal, tier)
    taxed_amount = subtotal - discount
    tax = calculate_tax(taxed_amount)
    total = taxed_amount + tax + DELIVERY_FEE
    return {
        "subtotal": round(subtotal, 2),
        "discount": round(discount, 2),
    taxed_amount = subtotal - discount
    tax = calculate_tax(taxed_amount)
    total = taxed_amount + tax + DELIVERY_FEE

    return {
        "subtotal": round(subtotal, 2),
        "discount": round(discount, 2),
        "tax": round(tax, 2),
        "total": round(total, 2),
    }
        "subtotal": round(subtotal, 2),
        "discount": round(discount, 2),
        "tax": round(tax, 2),
        "shipping_fee": round(DELIVERY_FEE, 2),
        "total": round(total, 2),
    }
