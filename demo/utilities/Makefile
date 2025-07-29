# demo/utilities/Makefile

ROOT_DIR := $(abspath $(CURDIR)/../..)
ENV_FILE := $(ROOT_DIR)/.env

ANVIL_PORT1 := 8545
ANVIL_PORT2 := 8546
ANVIL_RPC1 := http://127.0.0.1:$(ANVIL_PORT1)
ANVIL_RPC2 := http://127.0.0.1:$(ANVIL_PORT2)

CHAIN_ID1 := 111111
CHAIN_ID2 := 222222

SCRIPT_PATH := $(ROOT_DIR)/script/onlyswaps/DeployAllContracts.s.sol
SCRIPT_NAME := DeployAllContracts
CONFIGURE_SCRIPT_PATH := $(ROOT_DIR)/script/onlyswaps/utils/ConfigureRouterScript.s.sol
CONFIGURE_SCRIPT_NAME := ConfigureRouterScript

JSON_DIR := $(ROOT_DIR)/script/onlyswaps/json

start-anvil:
	@echo "Starting Anvil #1 on port $(ANVIL_PORT1) with chain id $(CHAIN_ID1)"
	@nohup anvil --port $(ANVIL_PORT1) --chain-id $(CHAIN_ID1) > anvil1.log 2>&1 & echo $$! > anvil1.pid
	@sleep 1
	@echo "Starting Anvil #2 on port $(ANVIL_PORT2) with chain id $(CHAIN_ID2)"
	@nohup anvil --port $(ANVIL_PORT2) --chain-id $(CHAIN_ID2) > anvil2.log 2>&1 & echo $$! > anvil2.pid
	@sleep 3
	@echo "Anvils started."

stop-anvil:
	@echo "Stopping Anvil #1"
	-@kill `cat anvil1.pid` 2>/dev/null || true
	-@rm -f anvil1.pid
	@echo "Stopping Anvil #2"
	-@kill `cat anvil2.pid` 2>/dev/null || true
	-@rm -f anvil2.pid

deploy-anvil1:
	@echo "Deploying contracts to Anvil #1 (chain id $(CHAIN_ID1))..."
	@bash -c ' \
		source $(ENV_FILE); \
		forge script $(SCRIPT_PATH):$(SCRIPT_NAME) --rpc-url $(ANVIL_RPC1) --private-key $$PRIVATE_KEY --broadcast; \
	'

deploy-anvil2:
	@echo "Deploying contracts to Anvil #2 (chain id $(CHAIN_ID2))..."
	@bash -c ' \
		source $(ENV_FILE); \
		forge script $(SCRIPT_PATH):$(SCRIPT_NAME) --rpc-url $(ANVIL_RPC2) --private-key $$PRIVATE_KEY --broadcast; \
	'

configure-router:
	@echo "Configuring routers on both chains..."
	@bash -c ' \
		source $(ENV_FILE); \
		CHAIN1_ID=$(CHAIN_ID1); \
		CHAIN2_ID=$(CHAIN_ID2); \
		JSON1=$(JSON_DIR)/$$CHAIN1_ID.json; \
		JSON2=$(JSON_DIR)/$$CHAIN2_ID.json; \
		\
		echo "------ Contents of deployment JSON for Chain1 ($$CHAIN1_ID) ------"; \
		cat $$JSON1 || echo "File $$JSON1 not found!"; \
		echo "------ Contents of deployment JSON for Chain2 ($$CHAIN2_ID) ------"; \
		cat $$JSON2 || echo "File $$JSON2 not found!"; \
		\
		if [ ! -f $$JSON1 ] || [ ! -f $$JSON2 ]; then \
			echo "Error: Deployment JSON files not found for chain IDs $$CHAIN1_ID or $$CHAIN2_ID"; \
			exit 1; \
		fi; \
		\
		ROUTER1=$$(jq -r .routerAddress $$JSON1); \
		ROUTER2=$$(jq -r .routerAddress $$JSON2); \
		RUSD1=$$(jq -r .rusdFaucet $$JSON1); \
		RUSD2=$$(jq -r .rusdFaucet $$JSON2); \
		\
		echo "Configuring router on Chain1 (id $$CHAIN1_ID)..."; \
		ROUTER_SRC_ADDRESS=$$ROUTER1 ERC20_SRC_ADDRESS=$$RUSD1 ERC20_DST_ADDRESS=$$RUSD2 DST_CHAIN_ID=$$CHAIN2_ID \
			forge script $(CONFIGURE_SCRIPT_PATH):$(CONFIGURE_SCRIPT_NAME) --rpc-url $(ANVIL_RPC1) --private-key $$PRIVATE_KEY --broadcast; \
		\
		echo "Configuring router on Chain2 (id $$CHAIN2_ID)..."; \
		ROUTER_SRC_ADDRESS=$$ROUTER2 ERC20_SRC_ADDRESS=$$RUSD2 ERC20_DST_ADDRESS=$$RUSD1 DST_CHAIN_ID=$$CHAIN1_ID \
			forge script $(CONFIGURE_SCRIPT_PATH):$(CONFIGURE_SCRIPT_NAME) --rpc-url $(ANVIL_RPC2) --private-key $$PRIVATE_KEY --broadcast; \
		\
		echo "Router configuration complete."; \
	'

AMOUNT_TOKENS := 5
FEE_TOKENS := 1

mint-and-swap:
	@echo "Minting tokens and requesting swap on Anvil #1..."
	@bash -c '\
		source $(ENV_FILE); \
		CHAIN_ID=$(CHAIN_ID1); \
		JSON=$(JSON_DIR)/$$CHAIN_ID.json; \
		\
		if [ ! -f $$JSON ]; then \
			echo "Error: Deployment JSON file $$JSON not found"; exit 1; \
		fi; \
		\
		ERC20_ADDR=$$(jq -r .rusdFaucet $$JSON); \
		ROUTER_ADDR=$$(jq -r .routerAddress $$JSON); \
		USER_ADDR=$$(cast wallet address --private-key $$PRIVATE_KEY); \
		AMOUNT=$$(cast to-wei $(AMOUNT_TOKENS) ether); \
		FEE=$$(cast to-wei $(FEE_TOKENS) ether); \
		TOTAL=$$(echo "$$AMOUNT + $$FEE" | bc); \
		DST_CHAIN_ID=$(CHAIN_ID2); \
		\
		echo "ERC20: $$ERC20_ADDR"; \
		echo "Router: $$ROUTER_ADDR"; \
		echo "User: $$USER_ADDR"; \
		echo "Amount: $$AMOUNT wei"; \
		echo "Fee: $$FEE wei"; \
		echo "Total mint: $$TOTAL wei"; \
		\
		echo "Minting tokens..."; \
		cast send $$ERC20_ADDR "mint()" --private-key $$PRIVATE_KEY --rpc-url $(ANVIL_RPC1) -- --broadcast; \
		\
		echo "Approving router..."; \
		cast send $$ERC20_ADDR "approve(address,uint256)" $$ROUTER_ADDR $$TOTAL --private-key $$PRIVATE_KEY --rpc-url $(ANVIL_RPC1) -- --broadcast; \
		\
		echo "Requesting cross chain swap..."; \
		cast send $$ROUTER_ADDR "requestCrossChainSwap(address,uint256,uint256,uint256,address)" $$ERC20_ADDR $$AMOUNT $$FEE $$DST_CHAIN_ID $$USER_ADDR --private-key $$PRIVATE_KEY --rpc-url $(ANVIL_RPC1) -- --broadcast; \
	'

full-cycle: stop-anvil start-anvil deploy-anvil1 deploy-anvil2 configure-router mint-and-swap stop-anvil

