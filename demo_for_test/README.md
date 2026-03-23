# 🛒 TRACE功能测试项目
这是一个专门为测试TRACE功能设计的最小化多文件Python项目。项目模拟了一个简单的电商系统，包含用户管理、商品管理、订单处理和支付功能。
## 📁 项目结构
```
trace_test_project/
├── main.py           # 主程序入口，演示完整业务流程
├── user.py           # 用户管理模块 (User, UserManager)
├── product.py        # 商品管理模块 (Product, ProductManager)
├── order.py          # 订单处理模块 (Order, OrderItem, OrderManager)
├── payment.py        # 支付处理模块 (Payment, PaymentMethod, PaymentManager)
├── utils.py          # 工具函数模块 (各种辅助函数)
└── README.md         # 项目说明文档
```
## 🎯 设计目标
### 1. 多文件关联性测试
- **依赖关系**: `order.py` → `user.py` + `product.py`
- **依赖关系**: `payment.py` → `order.py` + `utils.py`
- **依赖关系**: `main.py` → 所有模块
### 2. TRACE功能测试场景
当您修改某个文件时，TRACE应该能预测到其他相关文件也需要修改：
#### 场景1：修改用户字段
- **操作**: 在 `user.py` 的 `User` 类中添加新字段（如 `phone_number`）
- **预期**: TRACE应该建议修改 `order.py` 和 `payment.py` 中相关的用户处理逻辑
#### 场景2：修改商品结构  
- **操作**: 在 `product.py` 中为 `Product` 类添加新属性（如 `discount_rate`）
- **预期**: TRACE应该建议修改 `order.py` 中的订单计算逻辑和 `utils.py` 中的相关函数
#### 场景3：修改订单状态
- **操作**: 在 `order.py` 中修改订单状态枚举或添加新状态
- **预期**: TRACE应该建议修改 `payment.py` 中的支付状态检查逻辑
### 3. PIN功能测试场景
- 当TRACE预测出多个位置建议时，您可以PIN住重要的位置
- 再次触发预测时，被PIN的位置会保留，新预测的位置会合并显示
- 测试PIN功能在复杂项目结构中的表现
## 🚀 运行方法
```bash
cd trace_test_project
python main.py
```
## 💡 测试建议
### 步骤1：建立基线
1. 打开项目在VS Code中
2. 运行 `main.py` 确保项目正常工作
3. 熟悉各模块间的关联关系
### 步骤2：测试TRACE预测
1. 选择一个测试场景（如场景1）
2. 在 `user.py` 中准备添加新字段
3. 使用 `Ctrl+Alt+L` 触发位置预测
4. 观察TRACE建议的修改位置是否合理
### 步骤3：测试PIN功能
1. 在位置预测结果中PIN住重要位置
2. 再次修改代码并触发预测
3. 验证PIN的位置是否保留
4. 测试PIN/UNPIN操作的交互体验
### 步骤4：测试编辑生成
1. 点击建议的位置
2. 使用 `Ctrl+Alt+E` 生成编辑建议
3. 评估生成的代码是否符合上下文
## 📊 项目特点
- **🎯 小而精**: 每个文件不超过80行，易于理解
- **🔗 强关联**: 模块间有明确的依赖和调用关系  
- **⚡ 易测试**: 提供多种测试场景和清晰的预期结果
- **📝 好理解**: 电商系统业务逻辑直观易懂
- **🎨 可扩展**: 容易添加新功能来创建更多测试场景
## 🛠️ 扩展建议
如果需要更复杂的测试场景，可以考虑添加：
- `database.py` - 数据持久化模块
- `notification.py` - 通知服务模块  
- `analytics.py` - 数据分析模块
- `config.py` - 配置管理模块
这些扩展模块会创建更多的跨文件依赖关系，为TRACE提供更丰富的测试场景。