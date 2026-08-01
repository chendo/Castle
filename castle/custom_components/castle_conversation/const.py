"""Constants for the Castle conversation integration."""

DOMAIN = "castle_conversation"

# Default points at the add-on's internal Supervisor hostname. For a local
# install the host is usually "local-castle"; a store install gets a hashed
# prefix (see the add-on page for the exact hostname). 7090 is Castle's
# ingress_port, which is also the port the server listens on.
DEFAULT_URL = "http://local-castle:7090"

# Local models on modest hardware can take a while for a multi-tool turn.
DEFAULT_TIMEOUT = 120
