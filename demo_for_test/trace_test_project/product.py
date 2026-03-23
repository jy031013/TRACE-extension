"""
商品管理模块 - Product Management Module

提供商品数据结构和管理功能，支持TRACE功能测试中的商品属性修改场景。
当修改Product类时，TRACE应该能预测到order.py和utils.py中的相关逻辑需要更新。
"""

from datetime import datetime
from typing import Dict, List, Optional
from enum import Enum


class ProductCategory(Enum):
    """商品分类枚举"""
    ELECTRONICS = "电子产品"
    CLOTHING = "服装"
    BOOKS = "图书"
    FOOD = "食品"
    HOME = "家居"


class Product:
    """商品数据模型
    
    测试场景：在此类中添加新属性（如discount_rate），
    TRACE应预测order.py中的价格计算逻辑和utils.py中的相关函数需要修改。
    """
    
    def __init__(self, product_id: str, name: str, price: float, 
                 category: ProductCategory, stock_quantity: int = 0):
        self.product_id = product_id
        self.name = name
        self.price = price
        self.category = category
        self.stock_quantity = stock_quantity
        self.created_at = datetime.now()
        self.is_available = stock_quantity > 0
        # 预留属性用于TRACE测试 - 添加discount_rate时测试关联预测
        
    def update_price(self, new_price: float) -> None:
        """更新商品价格"""
        self.price = new_price
    
    def update_stock(self, quantity: int) -> None:
        """更新库存数量"""
        self.stock_quantity = quantity
        self.is_available = quantity > 0
    
    def can_purchase(self, quantity: int) -> bool:
        """检查是否可以购买指定数量 - order.py会调用此方法"""
        return self.is_available and self.stock_quantity >= quantity
    
    def get_final_price(self, quantity: int = 1) -> float:
        """获取最终价格 - order.py和utils.py会调用此方法"""
        # 未来添加discount_rate属性时，此方法需要更新
        return self.price * quantity
    
    def get_product_info(self) -> Dict:
        """获取商品信息字典 - 订单模块会调用此方法"""
        return {
            'product_id': self.product_id,
            'name': self.name,
            'price': self.price,
            'category': self.category.value,
            'stock_quantity': self.stock_quantity,
            'is_available': self.is_available
        }


class ProductManager:
    """商品管理器
    
    管理所有商品的创建、查询、更新等操作。
    订单和工具模块通过此类访问商品数据。
    """
    
    def __init__(self):
        self.products: Dict[str, Product] = {}
        self._next_product_id = 1
        self._init_sample_products()
    
    def _init_sample_products(self) -> None:
        """初始化示例商品"""
        sample_products = [
            ("iPhone 15", 7999.00, ProductCategory.ELECTRONICS, 10),
            ("MacBook Pro", 15999.00, ProductCategory.ELECTRONICS, 5),
            ("Python编程入门", 89.00, ProductCategory.BOOKS, 20),
            ("休闲T恤", 199.00, ProductCategory.CLOTHING, 30),
        ]
        
        for name, price, category, stock in sample_products:
            self.create_product(name, price, category, stock)
    
    def create_product(self, name: str, price: float, 
                      category: ProductCategory, stock_quantity: int = 0) -> Product:
        """创建新商品"""
        product_id = f"PROD_{self._next_product_id:04d}"
        self._next_product_id += 1
        
        product = Product(product_id, name, price, category, stock_quantity)
        self.products[product_id] = product
        return product
    
    def get_product(self, product_id: str) -> Optional[Product]:
        """根据ID获取商品"""
        return self.products.get(product_id)
    
    def get_available_products(self) -> List[Product]:
        """获取所有可用商品"""
        return [product for product in self.products.values() if product.is_available]
    
    def check_stock_availability(self, product_id: str, quantity: int) -> bool:
        """检查库存是否足够 - order.py会调用此方法"""
        product = self.get_product(product_id)
        return product is not None and product.can_purchase(quantity)
    
    def reserve_stock(self, product_id: str, quantity: int) -> bool:
        """预留库存 - order.py会调用此方法"""
        product = self.get_product(product_id)
        if product and product.can_purchase(quantity):
            product.update_stock(product.stock_quantity - quantity)
            return True
        return False