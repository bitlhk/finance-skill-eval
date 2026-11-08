import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from openjiuwen.core.context_engine.schema.config import CompressionRecallConfig
from openjiuwen.core.context_engine.processor.forked.compressor.base import PrefixCompactProcessor
from openjiuwen.core.context_engine.processor.forked.compressor.session_memory_compressor import SessionMemoryCompressor
from .context_archive_guard import (GuardedDialogueCompressor, GuardedCurrentRoundCompressor,
                                    GuardedRoundLevelCompressor, GuardedSessionMemoryCompressor)


class ContextArchiveGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_prefix_compressors_reject_failed_archive_when_recall_is_required(self):
        context = MagicMock()
        context.compression_recall_config.return_value = CompressionRecallConfig(enabled=True)
        with patch.object(PrefixCompactProcessor, '_archive_compressed_messages', new_callable=AsyncMock, return_value=None):
            for compressor in (GuardedDialogueCompressor, GuardedCurrentRoundCompressor, GuardedRoundLevelCompressor):
                with self.subTest(compressor=compressor.__name__), self.assertRaisesRegex(RuntimeError, '保留原始上下文'):
                    await object.__new__(compressor)._archive_compressed_messages(context=context, original_messages=[], span=MagicMock())

    async def test_memory_guard_requires_archive_only_when_messages_are_replaced(self):
        context = MagicMock()
        context.compression_recall_config.return_value = CompressionRecallConfig(enabled=True)
        with patch.object(SessionMemoryCompressor, '_archive_replaced_messages', new_callable=AsyncMock, return_value=None):
            compressor = GuardedSessionMemoryCompressor(MagicMock())
            with self.assertRaisesRegex(RuntimeError, '保留原始上下文'):
                await compressor._archive_replaced_messages(context=context, original_messages=[], messages_to_compress=[object()])
            self.assertIsNone(await compressor._archive_replaced_messages(context=context, original_messages=[], messages_to_compress=[]))

    async def test_active_dialogue_compression_keeps_framework_threshold(self):
        compressor = object.__new__(GuardedDialogueCompressor)
        window = MagicMock()
        with patch.object(GuardedDialogueCompressor, 'trigger_get_context_window', new_callable=AsyncMock, return_value=False):
            self.assertEqual(await compressor.on_get_context_window(MagicMock(), window), (None, window))
