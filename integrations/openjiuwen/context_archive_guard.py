"""Retain framework messages when a compression archive cannot be saved.

The SDK compressors treat recall archives as best effort.  Task sessions need
the stronger guarantee that compacting never discards their only original
messages, so these adapters retain the SDK algorithms and require an archive
before allowing the SDK to replace a message span.
"""
from openjiuwen.core.context_engine import ContextEngine
from openjiuwen.core.context_engine.schema.config import CompressionRecallConfig
from openjiuwen.core.context_engine.processor.forked.compressor.session_memory_compressor import SessionMemoryCompressor
from openjiuwen.core.context_engine.processor.forked.compressor.dialogue_compressor import DialogueCompressor
from openjiuwen.core.context_engine.processor.forked.compressor.current_round_compressor import CurrentRoundCompressor
from openjiuwen.core.context_engine.processor.forked.compressor.round_level_compressor import RoundLevelCompressor
from openjiuwen.harness.rails.context_engineer import ContextProcessorRail

ARCHIVE_FAILURE = '压缩归档保存失败，保留原始上下文'


def _require_archive(context, archive):
    get_config = getattr(context, 'compression_recall_config', None)
    config = get_config() if callable(get_config) else None
    if isinstance(config, CompressionRecallConfig) and config.enabled and archive is None:
        raise RuntimeError(ARCHIVE_FAILURE)
    return archive


class _GuardPrefixArchive:
    async def _archive_compressed_messages(self, *, context, original_messages, span):
        archive = await super()._archive_compressed_messages(context=context, original_messages=original_messages, span=span)
        return _require_archive(context, archive)


class GuardedDialogueCompressor(_GuardPrefixArchive, DialogueCompressor):
    async def on_get_context_window(self, context, context_window, **kwargs):
        # The SDK checks this particular processor's threshold by its built-in
        # name during active compression. Preserve that check for our adapter.
        if not await self.trigger_get_context_window(context, context_window, **kwargs):
            return None, context_window
        return await super().on_get_context_window(context, context_window, **kwargs)


class GuardedCurrentRoundCompressor(_GuardPrefixArchive, CurrentRoundCompressor):
    pass


class GuardedRoundLevelCompressor(_GuardPrefixArchive, RoundLevelCompressor):
    pass


class GuardedSessionMemoryCompressor(SessionMemoryCompressor):
    async def _archive_replaced_messages(self, *, context, original_messages, messages_to_compress):
        archive = await super()._archive_replaced_messages(context=context, original_messages=original_messages,
                                                            messages_to_compress=messages_to_compress)
        # An empty replacement cannot lose any original messages and the SDK
        # intentionally does not create an archive for it.
        return _require_archive(context, archive) if messages_to_compress else archive


_GUARDED = {
    'DialogueCompressor': GuardedDialogueCompressor,
    'CurrentRoundCompressor': GuardedCurrentRoundCompressor,
    'RoundLevelCompressor': GuardedRoundLevelCompressor,
    'SessionMemoryCompressor': GuardedSessionMemoryCompressor,
}


class TaskContextProcessorRail(ContextProcessorRail):
    def init(self, agent):
        super().init(agent)
        config = getattr(getattr(agent, 'react_agent', None), '_config', None)
        engine_config = getattr(config, 'context_engine_config', None)
        recall = getattr(engine_config, 'compression_recall_config', None)
        if config is None or not isinstance(recall, CompressionRecallConfig) or not recall.enabled:
            return
        for guarded in _GUARDED.values():
            ContextEngine.register_processor()(guarded)
        config.context_processors = [(_GUARDED[name].processor_type() if name in _GUARDED else name, value)
                                     for name, value in config.context_processors]
