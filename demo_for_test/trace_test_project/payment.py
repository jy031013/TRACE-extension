"""
支付处理模块 - Payment Processing Module

依赖order.py和utils.py模块，提供支付相关的数据结构和业务逻辑。
当order.py中的OrderStatus枚举修改时，此模块中的支付状态检查逻辑需要更新。
"""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional
from order import Order, OrderManager, OrderStatus
from utils import generate_payment_id, process_payment_validation, format_currency


class PaymentMethod(Enum):
    """支付方式枚举"""
    ALIPAY = "支付宝"
    WECHAT = "微信支付"
    CREDIT_CARD = "信用卡"
    BANK_TRANSFER = "银行转账"


class PaymentStatus(Enum):
    """支付状态枚举"""
    PENDING = "待支付"
    PROCESSING = "支付中"
    SUCCESS = "支付成功"
    FAILED = "支付失败"
    REFUNDED = "已退款"


class Payment:
    """支付数据模型"""
    
    def __init__(self, order: Order, payment_method: PaymentMethod):
        self.payment_id = generate_payment_id()
        self.order = order
        self.payment_method = payment_method
        self.amount = order.total_amount
        self.status = PaymentStatus.PENDING
        self.created_at = datetime.now()
        self.updated_at = self.created_at
        self.transaction_id = None  # 第三方交易ID
    
    def can_process_payment(self) -> bool:
        """检查是否可以处理支付
        
        当order.py中的OrderStatus枚举修改时，此方法需要更新
        """
        # 检查订单状态是否允许支付
        valid_order_statuses = [OrderStatus.PENDING, OrderStatus.CONFIRMED]
        return (self.order.status in valid_order_statuses and 
                self.status == PaymentStatus.PENDING)
    
    def process_payment(self, transaction_id: str) -> bool:
        """处理支付"""
        if not self.can_process_payment():
            return False
        
        self.status = PaymentStatus.PROCESSING
        self.transaction_id = transaction_id
        self.updated_at = datetime.now()
        
        # 模拟支付处理（实际应该调用第三方支付接口）
        success = self._simulate_payment_processing()
        
        if success:
            self.status = PaymentStatus.SUCCESS
            # 更新订单状态为已确认
            self.order.update_status(OrderStatus.CONFIRMED)
        else:
            self.status = PaymentStatus.FAILED
        
        self.updated_at = datetime.now()
        return success
    
    def _simulate_payment_processing(self) -> bool:
        """模拟支付处理过程"""
        import random
        # 90%的概率支付成功
        return random.random() > 0.1
    
    def refund(self) -> bool:
        """退款处理"""
        if self.status != PaymentStatus.SUCCESS:
            return False
        
        # 检查订单是否可以取消（影响退款）
        if not self.order.can_be_cancelled():
            return False
        
        self.status = PaymentStatus.REFUNDED
        self.updated_at = datetime.now()
        
        # 更新订单状态为已取消
        self.order.update_status(OrderStatus.CANCELLED)
        return True
    
    def get_payment_summary(self) -> Dict:
        """获取支付摘要"""
        return {
            'payment_id': self.payment_id,
            'order_id': self.order.order_id,
            'amount': self.amount,
            'formatted_amount': format_currency(self.amount),
            'payment_method': self.payment_method.value,
            'status': self.status.value,
            'transaction_id': self.transaction_id,
            'created_at': self.created_at.strftime("%Y-%m-%d %H:%M:%S")
        }


class PaymentManager:
    """支付管理器"""
    
    def __init__(self, order_manager: OrderManager):
        self.payments: Dict[str, Payment] = {}
        self.order_manager = order_manager
    
    def create_payment(self, order_id: str, payment_method: PaymentMethod) -> Optional[Payment]:
        """创建支付"""
        order = self.order_manager.get_order(order_id)
        if not order:
            return None
        
        # 检查订单是否可以支付
        if not order.can_be_paid():
            return None
        
        # 检查是否已有未完成的支付
        existing_payment = self.get_order_payment(order_id)
        if existing_payment and existing_payment.status in [PaymentStatus.PENDING, PaymentStatus.PROCESSING]:
            return None
        
        payment = Payment(order, payment_method)
        self.payments[payment.payment_id] = payment
        return payment
    
    def get_payment(self, payment_id: str) -> Optional[Payment]:
        """获取支付记录"""
        return self.payments.get(payment_id)
    
    def get_order_payment(self, order_id: str) -> Optional[Payment]:
        """获取订单的支付记录"""
        for payment in self.payments.values():
            if payment.order.order_id == order_id:
                return payment
        return None
    
    def process_payment(self, payment_id: str) -> Dict:
        """处理支付请求"""
        payment = self.get_payment(payment_id)
        if not payment:
            return {'success': False, 'error': '支付记录不存在'}
        
        # 验证支付数据
        payment_data = {
            'amount': payment.amount,
            'payment_method': payment.payment_method.value,
            'order_id': payment.order.order_id
        }
        
        validation_result = process_payment_validation(payment_data)
        if not validation_result['is_valid']:
            return {
                'success': False, 
                'error': '; '.join(validation_result['errors'])
            }
        
        # 生成交易ID并处理支付
        transaction_id = f"TXN_{validation_result['payment_id']}"
        success = payment.process_payment(transaction_id)
        
        if success:
            return {
                'success': True,
                'payment_id': payment.payment_id,
                'transaction_id': transaction_id,
                'message': '支付成功'
            }
        else:
            return {
                'success': False,
                'error': '支付处理失败，请重试'
            }
    
    def get_payments_by_status(self, status: PaymentStatus) -> List[Payment]:
        """根据状态获取支付记录"""
        return [payment for payment in self.payments.values() if payment.status == status]
    
    def get_user_payments(self, user_id: str) -> List[Payment]:
        """获取用户的所有支付记录"""
        return [payment for payment in self.payments.values() 
                if payment.order.user.user_id == user_id]
    
    def check_order_payment_status(self, order_id: str) -> str:
        """检查订单支付状态
        
        当order.py中的OrderStatus枚举修改时，此方法可能需要更新逻辑
        """
        order = self.order_manager.get_order(order_id)
        if not order:
            return "订单不存在"
        
        payment = self.get_order_payment(order_id)
        if not payment:
            if order.status == OrderStatus.PENDING:
                return "等待支付"
            else:
                return "无支付记录"
        
        return payment.status.value