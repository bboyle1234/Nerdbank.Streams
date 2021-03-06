import { OfferParameters } from "./OfferParameters";
import { AcceptanceParameters } from "./AcceptanceParameters";
import { MultiplexingStream } from "./MultiplexingStream";
import { randomBytes } from "crypto";
import { getBufferFrom, writeAsync } from "./Utilities";
import CancellationToken from "cancellationtoken";
import * as msgpack from 'msgpack-lite';
import { Deferred } from "./Deferred";
import { FrameHeader } from "./FrameHeader";

export interface Version {
    major: number;
    minor: number;
}

export interface HandshakeResult {
    isOdd: boolean;
    protocolVersion: Version;
}

export abstract class MultiplexingStreamFormatter {
    abstract writeHandshakeAsync(): Promise<Buffer>;
    abstract readHandshakeAsync(writeHandshakeResult: Buffer, cancellationToken: CancellationToken): Promise<HandshakeResult>;

    abstract writeFrameAsync(header: FrameHeader, payload?: Buffer): Promise<void>;
    abstract readFrameAsync(cancellationToken: CancellationToken): Promise<{ header: FrameHeader, payload: Buffer } | null>;

    abstract serializeOfferParameters(offer: OfferParameters): Buffer;
    abstract deserializeOfferParameters(payload: Buffer): OfferParameters;

    abstract serializerAcceptanceParameters(acceptance: AcceptanceParameters): Buffer;
    abstract deserializerAcceptanceParameters(payload: Buffer): AcceptanceParameters;

    abstract serializeContentProcessed(bytesProcessed: number): Buffer;
    abstract deserializeContentProcessed(payload: Buffer): number;

    abstract end(): void;

    protected static getIsOddRandomData(): Buffer {
        return randomBytes(16);
    }

    protected static isOdd(localRandom: Buffer, remoteRandom: Buffer): boolean {
        let isOdd: boolean | undefined;
        for (let i = 0; i < localRandom.length; i++) {
            const sent = localRandom[i];
            const recv = remoteRandom[i];
            if (sent > recv) {
                isOdd = true;
                break;
            } else if (sent < recv) {
                isOdd = false;
                break;
            }
        }

        if (isOdd === undefined) {
            throw new Error("Unable to determine even/odd party.");
        }

        return isOdd;
    }
}

export class MultiplexingStreamV1Formatter extends MultiplexingStreamFormatter {
    /**
     * The magic number to send at the start of communication when using v1 of the protocol.
     */
    private static readonly protocolMagicNumber = new Buffer([0x2f, 0xdf, 0x1d, 0x50]);

    constructor(private readonly stream: NodeJS.ReadWriteStream) {
        super();
    }

    end() {
        this.stream.end();
    }

    async writeHandshakeAsync(): Promise<Buffer> {
        const randomSendBuffer = MultiplexingStreamFormatter.getIsOddRandomData();
        const sendBuffer = Buffer.concat([MultiplexingStreamV1Formatter.protocolMagicNumber, randomSendBuffer]);
        await writeAsync(this.stream, sendBuffer);
        return randomSendBuffer;
    }

    async readHandshakeAsync(writeHandshakeResult: Buffer, cancellationToken: CancellationToken): Promise<HandshakeResult> {
        const localRandomBuffer = <Buffer>writeHandshakeResult;
        const recvBuffer = await getBufferFrom(this.stream, MultiplexingStreamV1Formatter.protocolMagicNumber.length + 16, false, cancellationToken);

        for (let i = 0; i < MultiplexingStreamV1Formatter.protocolMagicNumber.length; i++) {
            const expected = MultiplexingStreamV1Formatter.protocolMagicNumber[i];
            const actual = recvBuffer.readUInt8(i);
            if (expected !== actual) {
                throw new Error(`Protocol magic number mismatch. Expected ${expected} but was ${actual}.`);
            }
        }

        const isOdd = MultiplexingStreamFormatter.isOdd(localRandomBuffer, recvBuffer.slice(MultiplexingStreamV1Formatter.protocolMagicNumber.length));

        return { isOdd: isOdd, protocolVersion: { major: 1, minor: 0 } };
    }

    async writeFrameAsync(header: FrameHeader, payload?: Buffer): Promise<void> {
        const headerBuffer = new Buffer(7);
        headerBuffer.writeInt8(header.code, 0);
        headerBuffer.writeUInt32BE(header.channelId || 0, 1);
        headerBuffer.writeUInt16BE(payload?.length || 0, 5);
        await writeAsync(this.stream, headerBuffer);
        if (payload && payload.length > 0) {
            await writeAsync(this.stream, payload);
        }
    }

    async readFrameAsync(cancellationToken: CancellationToken): Promise<{ header: FrameHeader, payload: Buffer } | null> {
        const headerBuffer = await getBufferFrom(this.stream, 7, true, cancellationToken);
        if (headerBuffer === null) {
            return null;
        }

        const header = new FrameHeader(
            headerBuffer.readInt8(0),
            headerBuffer.readUInt32BE(1));
        const payloadLength = headerBuffer.readUInt16BE(5);
        const payload = await getBufferFrom(this.stream, payloadLength);
        return { header: header, payload: payload };
    }

    serializeOfferParameters(offer: OfferParameters): Buffer {
        const payload = new Buffer(offer.name, MultiplexingStream.ControlFrameEncoding);
        if (payload.length > MultiplexingStream.framePayloadMaxLength) {
            throw new Error("Name is too long.");
        }

        return payload;
    }

    deserializeOfferParameters(payload: Buffer): OfferParameters {
        return {
            name: payload.toString(MultiplexingStream.ControlFrameEncoding),
        };
    }

    serializerAcceptanceParameters(_: AcceptanceParameters): Buffer {
        return new Buffer([]);
    }

    deserializerAcceptanceParameters(_: Buffer): AcceptanceParameters {
        return {};
    }

    serializeContentProcessed(bytesProcessed: number): Buffer {
        throw new Error("Not supported in the V1 protocol.");
    }

    deserializeContentProcessed(payload: Buffer): number {
        throw new Error("Not supported in the V1 protocol.");
    }
}

export class MultiplexingStreamV2Formatter extends MultiplexingStreamFormatter {
    private static readonly ProtocolVersion: Version = { major: 2, minor: 0 };
    private readonly reader: msgpack.DecodeStream;
    private readonly writer: NodeJS.WritableStream;

    constructor(stream: NodeJS.ReadWriteStream) {
        super();
        this.reader = msgpack.createDecodeStream();
        stream.pipe(this.reader);

        this.writer = stream;
    }

    end() {
        this.writer.end();
    }

    async writeHandshakeAsync(): Promise<Buffer> {
        const randomData = MultiplexingStreamFormatter.getIsOddRandomData();
        const msgpackObject = [[MultiplexingStreamV2Formatter.ProtocolVersion.major, MultiplexingStreamV2Formatter.ProtocolVersion.minor], randomData];
        await writeAsync(this.writer, msgpack.encode(msgpackObject));
        return randomData;
    }

    async readHandshakeAsync(writeHandshakeResult: Buffer, cancellationToken: CancellationToken): Promise<HandshakeResult> {
        const handshake = await this.readMessagePackAsync(cancellationToken);
        if (handshake === null) {
            throw new Error("No data received during handshake.");
        }

        return {
            isOdd: MultiplexingStreamFormatter.isOdd(writeHandshakeResult, handshake[1]),
            protocolVersion: { major: handshake[0][0], minor: handshake[0][1] },
        };
    }

    async writeFrameAsync(header: FrameHeader, payload?: Buffer): Promise<void> {
        const msgpackObject: any[] = [header.code];
        if (header.channelId || (payload && payload.length > 0)) {
            msgpackObject.push(header.channelId);
            if (payload && payload.length > 0) {
                msgpackObject.push(payload);
            }
        }

        await writeAsync(this.writer, msgpack.encode(msgpackObject));
    }

    async readFrameAsync(cancellationToken: CancellationToken): Promise<{ header: FrameHeader; payload: Buffer; } | null> {
        const msgpackObject = <any[]>await this.readMessagePackAsync(cancellationToken);
        const header = new FrameHeader(msgpackObject[0], msgpackObject.length > 1 ? msgpackObject[1] : undefined);
        return {
            header: header,
            payload: msgpackObject[2] || Buffer.from([]),
        }
    }

    serializeOfferParameters(offer: OfferParameters): Buffer {
        const payload: any[] = [offer.name];
        if (offer.remoteWindowSize) {
            payload.push(offer.remoteWindowSize);
        }

        return msgpack.encode(payload);
    }

    deserializeOfferParameters(payload: Buffer): OfferParameters {
        const msgpackObject = msgpack.decode(payload);
        return {
            name: msgpackObject[0],
            remoteWindowSize: msgpackObject[1],
        };
    }

    serializerAcceptanceParameters(acceptance: AcceptanceParameters): Buffer {
        const payload: any[] = [];
        if (acceptance.remoteWindowSize) {
            payload.push(acceptance.remoteWindowSize);
        }

        return msgpack.encode(payload);
    }

    deserializerAcceptanceParameters(payload: Buffer): AcceptanceParameters {
        const msgpackObject = msgpack.decode(payload);
        return {
            remoteWindowSize: msgpackObject[0],
        };
    }

    serializeContentProcessed(bytesProcessed: number): Buffer {
        return msgpack.encode([bytesProcessed]);
    }

    deserializeContentProcessed(payload: Buffer): number {
        return msgpack.decode(payload)[0];
    }

    private async readMessagePackAsync(cancellationToken: CancellationToken): Promise<{} | [] | null> {
        const streamEnded = new Deferred<void>();
        while (true) {
            const readObject = this.reader.read();
            if (readObject === null) {
                const bytesAvailable = new Deferred<void>();
                this.reader.once("readable", bytesAvailable.resolve.bind(bytesAvailable));
                this.reader.once("end", streamEnded.resolve.bind(streamEnded));
                const endPromise = Promise.race([bytesAvailable.promise, streamEnded.promise]);
                await (cancellationToken ? cancellationToken.racePromise(endPromise) : endPromise);

                if (bytesAvailable.isCompleted) {
                    continue;
                }

                return null;
            }

            return readObject;
        }
    }
}
