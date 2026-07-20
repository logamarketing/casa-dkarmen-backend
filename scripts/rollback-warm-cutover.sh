#!/usr/bin/env bash
# ONE-LINE ROLLBACK — reverts the 2026-07-20 warm/D cutover on LIVE Karmen.
# Restores prompt, temperature, first_message, tool_ids, tts model/expressive,
# and speculative_turn from the pre-cutover snapshot. Nothing else is touched.
set -euo pipefail
cd "$(dirname "$0")/.."
SNAP="${1:-.karmen-agent-rollback-20260720-092953-warm-cutover.json}"
python3 -c "
import json,urllib.request,sys
snap=json.load(open('$SNAP'))['conversation_config']
patch={'conversation_config':{
 'agent':{'first_message':snap['agent']['first_message'],
          'prompt':{'prompt':snap['agent']['prompt']['prompt'],
                    'temperature':snap['agent']['prompt']['temperature'],
                    'tool_ids':snap['agent']['prompt']['tool_ids']}},
 'tts':{'model_id':snap['tts']['model_id'],'expressive_mode':snap['tts']['expressive_mode']},
 'turn':{'speculative_turn':snap['turn']['speculative_turn']}}}
req=urllib.request.Request('https://api.elevenlabs.io/v1/convai/agents/agent_9901k5y1nqype69akbe3j8swwwat',
 data=json.dumps(patch,ensure_ascii=False).encode(),
 headers={'xi-api-key':open('.el_key').read().strip(),'Content-Type':'application/json'},method='PATCH')
cc=json.load(urllib.request.urlopen(req))['conversation_config']
print('ROLLED BACK ->', cc['tts']['model_id'], '| temp', cc['agent']['prompt']['temperature'], '| tools', cc['agent']['prompt']['tool_ids'])
"
