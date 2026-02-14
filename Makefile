APP_NAME := peerserver
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME := $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)
GO := go

.PHONY: build build-linux build-arm build-all clean run test vet fmt deps

build:
	$(GO) build -ldflags "$(LDFLAGS)" -o $(APP_NAME) .

build-linux:
	GOOS=linux GOARCH=amd64 $(GO) build -ldflags "$(LDFLAGS)" -o $(APP_NAME)-linux-amd64 .

build-arm:
	GOOS=linux GOARCH=arm64 $(GO) build -ldflags "$(LDFLAGS)" -o $(APP_NAME)-linux-arm64 .

build-all: build-linux build-arm
	GOOS=darwin GOARCH=arm64 $(GO) build -ldflags "$(LDFLAGS)" -o $(APP_NAME)-darwin-arm64 .
	GOOS=darwin GOARCH=amd64 $(GO) build -ldflags "$(LDFLAGS)" -o $(APP_NAME)-darwin-amd64 .

run: build
	./$(APP_NAME)

run-config: build
	./$(APP_NAME) -config config.json

test:
	$(GO) test -v -race ./...

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...

deps:
	$(GO) mod tidy
	$(GO) mod download

clean:
	rm -f $(APP_NAME) $(APP_NAME)-linux-* $(APP_NAME)-darwin-*

install: build-linux
	cp $(APP_NAME)-linux-amd64 /usr/local/bin/$(APP_NAME)
	chmod +x /usr/local/bin/$(APP_NAME)

uninstall:
	rm -f /usr/local/bin/$(APP_NAME)
