#!/bin/bash
cd /mnt/f/yoyo-ide
cp projects/yoyo.ty input.ky
echo '=== M1 ==='
timeout 25 ./build/gen1.elf; echo "exit="$?
if [ -f output ]; then
  mv output gen2.elf && chmod +x gen2.elf
  echo "gen2: $(wc -c < gen2.elf)"
fi
echo '=== M2 ==='
if [ -f gen2.elf ]; then
  timeout 25 ./gen2.elf; echo "exit="$?
  if [ -f output ]; then
    mv output gen3.elf
    echo "gen3: $(wc -c < gen3.elf)"
  fi
fi
echo '=== M3 ==='
if [ -f gen3.elf ]; then
  timeout 25 ./gen3.elf; echo "exit="$?
  if [ -f output ]; then
    mv output gen4.elf
    echo "gen4: $(wc -c < gen4.elf)"
  fi
fi
echo '=== HASHES ==='
md5sum gen2.elf gen3.elf gen4.elf 2>/dev/null || true