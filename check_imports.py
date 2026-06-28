import struct
with open('mini-kyc.exe','rb') as f:
    data = f.read()

pe_off = struct.unpack('<I', data[0x3C:0x40])[0]
num_sections = struct.unpack('<H', data[pe_off+6:pe_off+8])[0]
opt_hdr_sz = struct.unpack('<H', data[pe_off+0x14:pe_off+0x16])[0]
sec_start = pe_off + 24 + opt_hdr_sz

sections = []
for i in range(num_sections):
    s = sec_start + i*40
    name = data[s:s+8].rstrip(b'\x00').decode()
    vsize = struct.unpack('<I', data[s+8:s+12])[0]
    vrva = struct.unpack('<I', data[s+12:s+16])[0]
    rsize = struct.unpack('<I', data[s+16:s+20])[0]
    roff = struct.unpack('<I', data[s+20:s+24])[0]
    sections.append({'name':name,'vsize':vsize,'vrva':vrva,'rsize':rsize,'roff':roff})

def rva_to_file(rva):
    for sec in sections:
        end = max(sec['vsize'], sec['rsize'])
        if sec['vrva'] <= rva < sec['vrva'] + end:
            return rva - sec['vrva'] + sec['roff']
    return None

import_rva = struct.unpack('<I', data[pe_off+0x78+0:pe_off+0x78+4])[0]
print(f'Import Directory RVA = 0x{import_rva:x}')
iid_off = rva_to_file(import_rva)
print(f'File offset = 0x{iid_off:x}')

for i in range(10):
    off = iid_off + i*20
    if off + 20 > len(data): break
    oft = struct.unpack('<I', data[off:off+4])[0]
    ts = struct.unpack('<I', data[off+4:off+8])[0]
    fwd = struct.unpack('<I', data[off+8:off+12])[0]
    name_rva = struct.unpack('<I', data[off+12:off+16])[0]
    ft = struct.unpack('<I', data[off+16:off+20])[0]
    if oft == 0 and ft == 0: break
    noff = rva_to_file(name_rva)
    dll_end = data.find(b'\x00', noff)
    dll_name = data[noff:dll_end].decode('ascii', errors='replace')
    print(f'DLL={dll_name} IAT_RVA=0x{ft:x} ILT_RVA=0x{oft:x}')
    thunk_rva = oft if oft else ft
    toff = rva_to_file(thunk_rva)
    for j in range(20):
        to = toff + j*8
        if to + 8 > len(data): break
        entry = struct.unpack('<Q', data[to:to+8])[0]
        if entry == 0: break
        if entry & 0x8000000000000000:
            print(f'  [{j}] Ordinal {entry & 0xffff}')
        else:
            ea = rva_to_file(entry)
            hint = struct.unpack('<H', data[ea:ea+2])[0]
            ne = data.find(b'\x00', ea+2)
            fn = data[ea+2:ne].decode('ascii', errors='replace')
            print(f'  [{j}] {fn} (hint={hint}, thunk_rva=0x{entry:x})')
    print()
