"""Conversation platform: the Castle Assist agent entity."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import aiohttp

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_TOKEN, CONF_URL, MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DEFAULT_TIMEOUT


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Register the Castle conversation agent for this config entry."""
    async_add_entities([CastleConversationEntity(entry)])


class CastleConversationEntity(conversation.ConversationEntity):
    """A conversation agent that forwards each turn to the Castle add-on.

    Castle owns the LLM loop and Home Assistant control, so this entity is a
    relay: it streams the reply from Castle's /conversation SSE endpoint into the
    chat log so the Assist UI updates live and TTS can start early. It appears in
    Settings > Voice assistants as a selectable conversation agent.
    """

    _attr_has_entity_name = True
    _attr_name = "Castle"

    def __init__(self, entry: ConfigEntry) -> None:
        """Store the endpoint config from the config entry."""
        self._url = entry.data[CONF_URL].rstrip("/")
        self._token = entry.data.get(CONF_TOKEN, "")
        self._attr_unique_id = entry.entry_id

    @property
    def supported_languages(self) -> list[str] | str:
        """Castle delegates language handling to the LLM, so accept anything."""
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Stream one turn from Castle into the chat log and build the result."""
        try:
            async for _content in chat_log.async_add_delta_content_stream(
                self.entity_id, self._stream_turn(user_input)
            ):
                pass
        except (aiohttp.ClientError, TimeoutError, RuntimeError) as err:
            intent_response = intent.IntentResponse(language=user_input.language)
            intent_response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                f"Error talking to Castle: {err}",
            )
            return conversation.ConversationResult(
                response=intent_response,
                conversation_id=chat_log.conversation_id,
            )

        return conversation.async_get_result_from_chat_log(user_input, chat_log)

    async def _stream_turn(
        self, user_input: conversation.ConversationInput
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield assistant content deltas from Castle's SSE stream.

        The first item establishes the assistant role; each subsequent item is an
        incremental text chunk, matching HA's AssistantContentDeltaDict shape.
        """
        session = async_get_clientsession(self.hass)
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        payload = {
            "text": user_input.text,
            "conversation_id": user_input.conversation_id,
            "language": user_input.language,
            "stream": True,
        }

        yield {"role": "assistant"}

        async with session.post(
            f"{self._url}/conversation",
            json=payload,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                data = await resp.json()
                raise RuntimeError(data.get("error") or f"HTTP {resp.status}")
            async for event, data in _iter_sse(resp):
                if event == "delta":
                    text = data.get("text")
                    if text:
                        yield {"content": text}
                elif event == "error":
                    raise RuntimeError(data.get("error") or "Castle stream error")
                elif event == "done":
                    return


async def _iter_sse(
    resp: aiohttp.ClientResponse,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Parse a text/event-stream body into (event, data) pairs."""
    event = "message"
    data_lines: list[str] = []
    async for raw in resp.content:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":  # blank line dispatches the buffered event
            if data_lines:
                yield event, json.loads("\n".join(data_lines))
            event = "message"
            data_lines = []
        elif line.startswith(":"):
            continue  # SSE comment / keep-alive
        elif line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:") :].lstrip())
    if data_lines:  # stream ended without a trailing blank line
        yield event, json.loads("\n".join(data_lines))
