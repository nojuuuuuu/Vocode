import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConversation, saveConversation } from '../public/conversation-store.js';

test('agent conversations and proposals survive a reload and stay with their workspace', async () => {
  const workspacePath = '/tmp/vocode-history-a';
  const snapshot = {
    version: 1, workspacePath, activeAgentId: 2, nextAgentNumber: 3,
    agents: [{
      id: 2, name: 'エージェント 2', draft: '続きの質問', busy: false, scrollTop: 120,
      messages: [{ role: 'user', content: '説明して' }, { role: 'assistant', content: '説明します。' }],
      entries: [
        { kind: 'message', role: 'user', content: '説明して', error: false, label: 'あなた', sources: [] },
        { kind: 'message', role: 'assistant', content: '説明します。', error: false, label: 'Vocode · 回答', sources: [] },
        { kind: 'proposal', files: [{ path: 'src/App.tsx', content: 'x'.repeat(300_000) }], workspacePath, baseVersions: {}, existingAtRequest: [], status: 'pending' }
      ]
    }]
  };

  await saveConversation(snapshot);
  snapshot.agents[0].entries.length = 0;
  const restored = await loadConversation(workspacePath);
  assert.equal(restored.activeAgentId, 2);
  assert.equal(restored.agents[0].draft, '続きの質問');
  assert.equal(restored.agents[0].messages[1].content, '説明します。');
  assert.equal(restored.agents[0].entries[2].files[0].content.length, 300_000);
  assert.equal(await loadConversation('/tmp/vocode-history-b'), null);

  restored.agents[0].entries[2].status = 'applied';
  await saveConversation(restored);
  assert.equal((await loadConversation(workspacePath)).agents[0].entries[2].status, 'applied');
});
