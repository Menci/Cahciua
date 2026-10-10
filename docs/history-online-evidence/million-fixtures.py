"""Generate synthetic text with measured o200k_base token counts, no model calls.

python3 -m pip install --target /tmp/history-tokenizer tiktoken==0.14.0
PYTHONPATH=/tmp/history-tokenizer TIKTOKEN_CACHE_DIR=/tmp/history-tokenizer-cache \
  python3 docs/history-online-evidence/million-fixtures.py --out NEW_JSON
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

import tiktoken

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
if out.exists():
    raise RuntimeError('Fixture output must be new')
encoding = tiktoken.get_encoding('o200k_base')
seeds = [
    '工程讨论：历史消息需要保留全文、回复关系和修改记录。We measured the worker rather than guessing its memory usage. SELECT chat_id, message_id FROM events WHERE received_at > 42; <tag key="value">A & B</tag>\n',
    '用户反馈：这条消息包含中文、English words、数字 123456 和表情🙂。const result = await buildHistoryInput({ pageSize: 8 }); 内容不能被截断。Compare the hash at the end of every saved message.\n',
    '在线恢复：进程崩溃后继续读取事务日志。The checkpoint advances only after the saved text, search index and relations commit together. {"success":true,"rows":[1,2,3]}\n',
    '资源测试：CPU、RSS、heap、database WAL 都分别采样。A long reply thread should restore the direct parent without walking all ancestors. quotation: "full text" & <markup>.\n',
]

def measured_text(seed, target):
    seed_tokens = len(encoding.encode_ordinary(seed))
    encoded = encoding.encode_ordinary(seed * (target // seed_tokens + 10))
    for trim in range(16):
        prefix = encoding.decode(encoded[:target - trim])
        if '\ufffd' in prefix:
            continue
        # Each newline is a token; suffix boundaries are checked, never assumed.
        for extra in range(16):
            text = prefix + '\n' * extra
            count = len(encoding.encode_ordinary(text))
            if count == target:
                return {'text': text, 'tokens': count, 'utf8Bytes': len(text.encode()), 'sha256': hashlib.sha256(text.encode()).hexdigest()}
    raise RuntimeError(f'Could not produce exactly {target} tokens')

fixture = {
    'tokenizer': {'package': 'tiktoken', 'version': importlib.metadata.version('tiktoken'), 'encoding': 'o200k_base', 'scope': 'text bodies only; excludes wire metadata and role overhead'},
    'short': [measured_text(seed, 1000) for seed in seeds],
    'long': measured_text(seeds[0], 1000000),
    'half': measured_text(seeds[1], 500000),
}
out.write_text(json.dumps(fixture, ensure_ascii=False))
print(json.dumps({'tokenizer': fixture['tokenizer'], 'shortTokens': [x['tokens'] for x in fixture['short']], 'longTokens': fixture['long']['tokens'], 'longUtf8Bytes': fixture['long']['utf8Bytes'], 'halfTokens': fixture['half']['tokens']}))
