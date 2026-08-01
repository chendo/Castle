"""Config flow for the Castle conversation integration."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.const import CONF_TOKEN, CONF_URL
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_URL, DOMAIN

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigFlowResult
    from homeassistant.helpers.service_info.hassio import HassioServiceInfo


class CannotConnect(Exception):
    """Raised when Castle can't be reached at the given URL."""


class CastleConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the UI setup for the Castle conversation agent."""

    VERSION = 1

    def __init__(self) -> None:
        """Hold discovery data between the hassio and confirm steps."""
        self._discovered: dict[str, str] = {}

    async def async_step_hassio(
        self, discovery_info: "HassioServiceInfo"
    ) -> "ConfigFlowResult":
        """Handle auto-discovery from the Castle add-on (Supervisor discovery)."""
        config = discovery_info.config or {}
        url = (config.get(CONF_URL) or DEFAULT_URL).rstrip("/")
        await self.async_set_unique_id(url)
        self._abort_if_unique_id_configured()
        self._discovered = {CONF_URL: url, CONF_TOKEN: config.get(CONF_TOKEN, "")}
        self.context["title_placeholders"] = {"name": "Castle"}
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> "ConfigFlowResult":
        """Confirm the discovered Castle add-on before creating the entry."""
        if user_input is not None:
            try:
                await self._validate(self._discovered[CONF_URL], self._discovered[CONF_TOKEN])
            except CannotConnect:
                return self.async_abort(reason="cannot_connect")
            return self.async_create_entry(title="Castle", data=self._discovered)
        return self.async_show_form(
            step_id="hassio_confirm",
            description_placeholders={"url": self._discovered[CONF_URL]},
        )

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> "ConfigFlowResult":
        """Collect the Castle URL (and optional token) and verify reachability."""
        errors: dict[str, str] = {}

        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            token = user_input.get(CONF_TOKEN, "")
            try:
                await self._validate(url, token)
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title="Castle",
                    data={CONF_URL: url, CONF_TOKEN: token},
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_URL, default=DEFAULT_URL): str,
                vol.Optional(CONF_TOKEN, default=""): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def _validate(self, url: str, token: str) -> None:
        """Hit Castle's /health endpoint to confirm the URL is reachable."""
        session = async_get_clientsession(self.hass)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with session.get(
                f"{url}/health",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    raise CannotConnect
        except (aiohttp.ClientError, TimeoutError) as err:
            raise CannotConnect from err
