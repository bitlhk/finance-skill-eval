"""The old application's registration boundary; no business behavior here."""
from .ledger import query_receivables, summarize_receivables


def register(agent):
    for function in (query_receivables, summarize_receivables):
        agent.register_tool(function)
