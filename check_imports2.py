import struct

with open('mini-kyc.exe','rb') as f:
    data = f.read()

pe_off = struct.unpack('<I', data[0x3C:0x40])[0]
print(f'PE offset: 0x{pe_off:x}')

# Read IMAGE_FILE_HEADER at pe_off + 4
num_sects = struct.unpack('<H', data[pe_off+6:pe_off+8])[0]
opt_hdr_sz = struct.unpack('<H', data[pe_off+0x14:pe_off+0x16])[0]
print(f'# sections: {num_sects}, optional header size: {opt_hdr_sz}')

# Read NumberOfRvaAndSizes at offset 0x18+108 from pe_off
nrv = struct.unpack('<I', data[pe_off+24+108:pe_off+24+108+4])[0]
print(f'NumberOfRvaAndSizes: {nrv}')

# DataDirectory[1] (Import) at pe_off+24+112+8 = pe_off+24+120 = pe_off+144
import_rva = struct.unpack('<I', data[pe_off+24+112+8+0:pe_off+24+112+8+4])[0]
import_sz = struct.unpack('<I', data[pe_off+24+112+8+4:pe_off+24+112+8+8])[0]
print(f'Import Directory: RVA=0x{import_rva:x} Size=0x{import_sz:x}')

# Section headers
sec_start = pe_off + 24 + opt_hdr_sz
sections = []
for i in range(num_sects):
    s = sec_start + i*40
    name = data[s:s+8].rstrip(b'\x00').decode()
    vsize = struct.unpack('<I', data[s+8:s+12])[0]
    vrva = struct.unpack('<I', data[s+12:s+16])[0]
    rsize = struct.unpack('<I', data[s+16:s+20])[0]
    roff = struct.unpack('<I', data[s+20:s+24])[0]
    sections.append({'name':name,'vsize':vsize,'vrva':vrva,'rsize':rsize,'roff':roff})
    print(f'  {name}: RVA=0x{vrva:x} VSize=0x{vsize:x} RSize=0x{rsize:x} ROff=0x{roff:x}')

def rva_to_file(rva):
    for sec in sections:
        end = max(sec['vsize'], sec['rsize'])
        if sec['vrva'] <= rva < sec['vrva'] + end:
            return rva - sec['vrva'] + sec['roff']
    return None

# Check what's at the import directory RVA
iid_off = rva_to_file(import_rva)
if iid_off:
    print(f'\nImport descriptors at file offset 0x{iid_off:x}:')
    for i in range(10):
        off = iid_off + i*20
        if off + 20 > len(data): break
        oft = struct.unpack('<I', data[off:off+4])[0]        # OriginalFirstThunk
        ts  = struct.unpack('<I', data[off+4:off+8])[0]     # TimeDateStamp
        fwd = struct.unpack('<I', data[off+8:off+12])[0]     # ForwarderChain
        nrv = struct.unpack('<I', data[off+12:off+16])[0]    # Name
        ft  = struct.unpack('<I', data[off+16:off+20])[0]    # FirstThunk
        if oft == 0 and ft == 0 and ts == 0:
            print(f'  [{i}] end marker')
            break
        # DLL name
        noff = rva_to_file(nrv)
        dll_end = data.find(b'\x00', noff)
        dll_name = data[noff:dll_end].decode('ascii', errors='replace')
        print(f'  [{i}] DLL={dll_name} IAT=0x{ft:x} ILT=0x{oft:x}')
        # Read import thunks
        thunk_rva = oft if oft else ft
        thunk_off = rva_to_file(thunk_rva)
        if thunk_off:
            for j in range(20):
                to = thunk_off + j*8
                if to + 8 > len(data): break
                entry = struct.unpack('<Q', data[to:to+8])[0]
                if entry == 0: break
                if entry & 0x8000000000000000:
                    print(f'    [{j}] Ordinal {entry & 0xffff}')
                else:
                    ea = rva_to_file(entry)
                    if ea:
                        hint = struct.unpack('<H', data[ea:ea+2])[0]
                        ne = data.find(b'\x00', ea+2)
                        fn = data[ea+2:ne].decode('ascii', errors='replace')
                        print(f'    [{j}] {fn} (hint={hint}, thunk=0x{entry:x})')
else:
    print(f'Import RVA 0x{import_rva:x} not in any section!')
