"""The Castle conversation integration.

A thin bridge that exposes the Castle add-on as a Home Assistant Assist
conversation agent. All the real work (the LLM loop and Home Assistant control)
happens inside the Castle add-on; this integration just relays a turn's text to
the add-on's /conversation endpoint and returns the reply into the Assist
pipeline.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

PLATFORMS = [Platform.CONVERSATION]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Castle from a config entry."""
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
