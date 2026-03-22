PRODUCTS = {
    "notebook": {"name": "Notebook", "price": 12.0},
    "pen": {"name": "Pen", "price": 2.5},
    "sticker": {"name": "Sticker Pack", "price": 5.0},
}


def get_product(product_id: str) -> dict:
    try:
        return PRODUCTS[product_id]
    except KeyError as exc:
        raise ValueError(f"Unknown product: {product_id}") from exc
