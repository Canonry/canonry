#!/usr/bin/env bash
# Pull a Dockerfile's base images before `docker build`, retrying registry
# failures.
#
# ECR Public caps anonymous pulls with a data quota that GitHub-hosted runners
# share. When it is exhausted, BuildKit's `FROM` resolution gets `429 Too Many
# Requests` and the build fails in its first second. The runner's docker
# buildx driver uses an image already in the local store without contacting
# the registry, so pulling first moves that failure into a loop that retries.
#
# Docker Official Images on ECR Public (public.ecr.aws/docker/library/*) are
# the images Docker Hub serves as library/*, with the same digests. When an ECR
# pull fails, the same reference is pulled from Docker Hub, which has a
# separate quota, and every FROM naming that image is pointed at the Docker Hub
# reference. Tagging the copy with the ECR name is not possible for a
# digest-pinned FROM: Docker refuses to create a tag that contains a digest.
# The rewrite edits the Dockerfile in place, so run this only in a disposable
# checkout, before the build that reads the same file.
set -euo pipefail

dockerfile=${1:?usage: pull-docker-base-images.sh <Dockerfile>}
attempts=${PULL_ATTEMPTS:-5}
delay=${PULL_RETRY_DELAY_SECONDS:-10}

# `FROM [--flag=...] <image> [AS <stage>]`. A FROM naming an earlier stage or
# scratch has nothing to pull; a repeated image is pulled once.
images=()
while IFS= read -r image; do
  images+=("$image")
done < <(awk '
  toupper($1) == "FROM" {
    i = 2
    while ($i ~ /^--/) i++
    image = $i
    if (tolower(image) != "scratch" && !(tolower(image) in stages) && !(image in seen)) {
      seen[image] = 1
      print image
    }
    if (tolower($(i + 1)) == "as") stages[tolower($(i + 2))] = 1
  }
' "$dockerfile")

if [ "${#images[@]}" -eq 0 ]; then
  echo "::error::No base images found in $dockerfile"
  exit 1
fi

for image in "${images[@]}"; do
  if [[ $image == *'$'* ]]; then
    echo "::error::Cannot pull $image before the build: it depends on a build argument"
    exit 1
  fi
done

# Point every FROM that names an image at a replacement, with the same parse as
# the list above. Other lines, including mentions of the image outside FROM,
# keep their bytes.
use_base_image() {  # <dockerfile> <image> <replacement>
  local rewritten
  rewritten=$(mktemp)
  awk -v image="$2" -v replacement="$3" '
    toupper($1) == "FROM" {
      i = 2
      while ($i ~ /^--/) i++
      if ($i == image) $i = replacement
    }
    { print }
  ' "$1" > "$rewritten"
  cat "$rewritten" > "$1"
  rm -f "$rewritten"
}

for image in "${images[@]}"; do
  fallback=""
  case $image in
    public.ecr.aws/docker/library/*) fallback="docker.io/library/${image#public.ecr.aws/docker/library/}" ;;
  esac

  wait=$delay
  for ((attempt = 1; ; attempt++)); do
    if docker pull --quiet "$image"; then
      break
    fi
    if [ -n "$fallback" ] && docker pull --quiet "$fallback"; then
      use_base_image "$dockerfile" "$image" "$fallback"
      echo "Pulled $fallback; $dockerfile now builds from it instead of $image"
      break
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::error::Could not pull $image${fallback:+ or $fallback} after $attempts attempts"
      exit 1
    fi
    echo "Could not pull $image (attempt $attempt/$attempts); retrying in ${wait}s"
    sleep "$wait"
    wait=$((wait * 2))
  done
done
