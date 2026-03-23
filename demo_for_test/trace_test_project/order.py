"""
订单处理模块 - Order Management Module

依赖user.py和product.py模块，提供订单相关的数据结构和业务逻辑。
当修改订单状态枚举时，TRACE应该能预测到payment.py中的支付状态检查逻辑需要更新。
"""

from datetime import datetime
from enum import Enum
from typing import List, Dict, Optional
from user import User, UserManager
from product import Product, ProductManager
from utils import generate_order_number, calculate_order_total, calculate_estimated_delivery


class OrderStatus(Enum):
    """订单状态枚举
    
    测试场景：在此枚举中添加新状态或修改现有状态时，
    TRACE应预测payment.py中的支付状态检查逻辑需要更新。
    """
    PENDING = "待确认"
    CONFIRMED = "已确认"
    PROCESSING = "处理中"
    SHIPPED = "已发货"
    DELIVERED = "已送达"
    CANCELLED = "已取消"
    # 预留状态用于TRACE测试 - 添加新状态时测试关联预测


class OrderItem:
    """订单项目数据模型"""
    
    def __init__(self, product: Product, quantity: int):
        self.product = product
        self.quantity = quantity
        self.unit_price = product.price
        # 当product.py中添加discount_rate时，这里需要更新价格计算
        self.total_price = self.unit_price * quantity
    
    def get_item_info(self) -> Dict:
        """获取订单项信息"""
        return {
            'product_id': self.product.product_id,
            'product_name': self.product.name,
            'quantity': self.quantity,
            'unit_price': self.unit_price,
            'total_price': self.total_price
        }


class Order:
    """订单数据模型"""
    
    def __init__(self, user: User, items: List[OrderItem]):
        self.order_id = generate_order_number()
        self.user = user
        self.items = items
        self.status = OrderStatus.PENDING
        self.created_at = datetime.now()
        self.updated_at = self.created_at
        
        # 计算订单金额
        self._calculate_totals()
        
        # 预计送达时间
        shipping_info = self._get_shipping_info()
        if shipping_info:
            self.estimated_delivery = calculate_estimated_delivery(
                self.created_at, shipping_info['address']
            )
        else:
            self.estimated_delivery = None
    
    def _calculate_totals(self):
        """计算订单总价"""
        items_data = [item.get_item_info() for item in self.items]
        shipping_address = self.user.address or ""
        
        # 调用utils模块计算总金额
        totals = calculate_order_total(items_data, shipping_address)
        
        self.subtotal = totals['subtotal']
        self.shipping_fee = totals['shipping_fee']
        self.tax_amount = totals['tax_amount']
        self.total_amount = totals['total_amount']
    
    def _get_shipping_info(self) -> Optional[Dict]:
        """获取配送信息"""
        if self.user.address:
            return {
                'name': self.user.name,
                'address': self.user.address,
                'email': self.user.email
            }
        return None
    
    def update_status(self, new_status: OrderStatus) -> None:
        """更新订单状态 - payment.py会调用此方法"""
        self.status = new_status
        self.updated_at = datetime.now()
    
    def can_be_paid(self) -> bool:
        """检查订单是否可以支付 - payment.py会调用此方法"""
        return self.status in [OrderStatus.PENDING, OrderStatus.CONFIRMED]
    
    def can_be_cancelled(self) -> bool:
        """检查订单是否可以取消"""
        return self.status in [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.PROCESSING]
    
    def get_order_summary(self) -> Dict:
        """获取订单摘要信息 - payment.py会调用此方法"""
        return {
            'order_id': self.order_id,
            'user_id': self.user.user_id,
            'user_name': self.user.name,
            'status': self.status.value,
            'total_amount': self.total_amount,
            'item_count': len(self.items),
            'created_at': self.created_at.strftime("%Y-%m-%d %H:%M:%S")
        }


class OrderManager:
    """订单管理器"""
    
    def __init__(self, user_manager: UserManager, product_manager: ProductManager):
        self.orders: Dict[str, Order] = {}
        self.user_manager = user_manager
        self.product_manager = product_manager
    
    def create_order(self, user_id: str, product_orders: List[Dict]) -> Optional[Order]:
        """创建订单
        
        Args:
            user_id: 用户ID
            product_orders: 商品订单列表 [{'product_id': str, 'quantity': int}, ...]
        """
        # 验证用户
        if not self.user_manager.validate_user_for_order(user_id):
            return None
        
        user = self.user_manager.get_user(user_id)
        if not user:
            return None
        
        # 创建订单项目
        order_items = []
        for item_data in product_orders:
            product_id = item_data['product_id']
            quantity = item_data['quantity']
            
            # 检查商品和库存
            if not self.product_manager.check_stock_availability(product_id, quantity):
                return None
            
            product = self.product_manager.get_product(product_id)
            if product:
                order_item = OrderItem(product, quantity)
                order_items.append(order_item)
                
                # 预留库存
                self.product_manager.reserve_stock(product_id, quantity)
        
        if not order_items:
            return None
        
        # 创建订单
        order = Order(user, order_items)
        self.orders[order.order_id] = order
        return order
    
    def get_order(self, order_id: str) -> Optional[Order]:
        """获取订单"""
        return self.orders.get(order_id)
    
    def get_user_orders(self, user_id: str) -> List[Order]:
        """获取用户的所有订单"""
        return [order for order in self.orders.values() if order.user.user_id == user_id]
    
    def get_orders_by_status(self, status: OrderStatus) -> List[Order]:
        """根据状态获取订单 - payment.py会调用此方法"""
        return [order for order in self.orders.values() if order.status == status]