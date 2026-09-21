from agentscope.tool import Toolkit
from tools.balance import get_balance

def build_toolkit(context):
    toolkit = Toolkit()
    toolkit.register_tool_function(get_balance, preset_kwargs={'context': context})
    return toolkit
