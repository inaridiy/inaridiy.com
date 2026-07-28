---
cms_id: "01KYM60GTYC95QAZDQ3FT595XP"
slug: "vm-setup-script"
status: "published"
title: "VM用初期セットアップシェルスクリプト"
---

最近AI Agent用などでクリーンなVMを切ることが多くなり面倒だったので、初期セットアップ用のスクリプトを作った。
とにかく多めに、AI Agentが欲しがるものを全部詰め込んでいる。

```bash
sudo apt update -y && sudo apt install -y curl ca-certificates
sudo install -dm 755 /etc/apt/keyrings
curl -fSs https://mise.en.dev/gpg-key.pub | sudo tee /etc/apt/keyrings/mise-archive-keyring.asc 1> /dev/null
echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.en.dev/deb stable main" | sudo tee /etc/apt/sources.list.d/mise.list
sudo apt update -y
sudo apt install -y mise

echo 'eval "$(/usr/bin/mise activate bash)"' >> ~/.bashrc

source ~/.bashrc

sudo apt install -y build-essential git wget unzip zip rsync tree make cmake pkg-config sqlite3 tmux entr moreutils

mise use -g node@24 rust@nightly uv python@3.10 fd jq yq bat fzf shellcheck shfmt

mise exec node -- npm i -g @openai/codex pnpm @anthropic-ai/claude-code

# Add Docker's official GPG key:
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update

sudo apt install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin \
  docker-ce-rootless-extras \
  uidmap

sudo systemctl disable --now docker.service docker.socket
sudo rm -f /var/run/docker.sock

dockerd-rootless-setuptool.sh install

sudo loginctl enable-linger "$USER"
```
