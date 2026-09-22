import json
from agentscope.message import TextBlock
from agentscope.tool import ToolBase, ToolResponse, Toolkit
from tools.request import get_request
from tools.budget import check_budget
from tools.supplier import check_supplier

class BusinessTool(ToolBase):
    is_concurrency_safe = True
    is_read_only = True
    def __init__(self, context):
        super().__init__()
        self.context = context
    def response(self, value):
        return ToolResponse(content=[TextBlock(type='text', text=json.dumps(value))], metadata={'businessResult': value})

class GetRequestTool(BusinessTool):
    name = 'get_request'
    description = '读取采购申请'
    input_schema = {'type': 'object', 'properties': {'request_id': {'type': 'string'}}, 'required': ['request_id']}
    async def call(self, request_id: str): return self.response(get_request(request_id, self.context))

class CheckBudgetTool(BusinessTool):
    name = 'check_budget'
    description = '检查部门预算'
    input_schema = {'type': 'object', 'properties': {'department': {'type': 'string'}, 'amount': {'type': 'string'}}, 'required': ['department', 'amount']}
    async def call(self, department: str, amount: str): return self.response(check_budget(department, amount, self.context))

class CheckSupplierTool(BusinessTool):
    name = 'check_supplier'
    description = '检查供应商状态'
    input_schema = {'type': 'object', 'properties': {'supplier': {'type': 'string'}}, 'required': ['supplier']}
    async def call(self, supplier: str): return self.response(check_supplier(supplier, self.context))

def build_toolkit(context):
    return Toolkit(tools=[GetRequestTool(context), CheckBudgetTool(context), CheckSupplierTool(context)])
