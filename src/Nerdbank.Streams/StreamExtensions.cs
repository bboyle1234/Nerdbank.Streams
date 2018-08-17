﻿// Copyright (c) Andrew Arnott. All rights reserved.
// Licensed under the MIT license. See LICENSE.txt file in the project root for full license information.

namespace Nerdbank.Streams
{
    using System.Buffers;
    using System.IO;
    using System.Net.WebSockets;

    /// <summary>
    /// Stream extension methods.
    /// </summary>
    public static class StreamExtensions
    {
        /// <summary>
        /// Creates a <see cref="Stream"/> that can read no more than a given number of bytes from an underlying stream.
        /// </summary>
        /// <param name="stream">The stream to read from.</param>
        /// <param name="length">The number of bytes to read from the parent stream.</param>
        /// <returns>A stream that ends after <paramref name="length"/> bytes are read.</returns>
        public static Stream ReadSlice(this Stream stream, long length) => new NestedStream(stream, length);

        /// <summary>
        /// Exposes a <see cref="WebSocket"/> as a <see cref="Stream"/>.
        /// </summary>
        /// <param name="webSocket">The <see cref="WebSocket"/> to use as a transport for the returned <see cref="Stream"/>.</param>
        /// <returns>A bidirectional <see cref="Stream"/>.</returns>
        public static Stream AsStream(this WebSocket webSocket) => new WebSocketStream(webSocket);

        /// <summary>
        /// Exposes a <see cref="ReadOnlySequence{T}"/> of <see cref="byte"/> as a <see cref="Stream"/>.
        /// </summary>
        /// <param name="readOnlySequence">The sequence of bytes to expose as a stream.</param>
        /// <returns>The readable stream.</returns>
        public static Stream AsStream(this ReadOnlySequence<byte> readOnlySequence) => new ReadOnlySequenceStream(readOnlySequence);

        /// <summary>
        /// Creates a writable <see cref="Stream"/> that can be used to add to a <see cref="IBufferWriter{T}"/> of <see cref="byte"/>.
        /// </summary>
        /// <param name="writer">The buffer writer the stream should write to.</param>
        /// <returns>A <see cref="Stream"/>.</returns>
        public static Stream AsStream(this IBufferWriter<byte> writer) => new BufferWriterStream(writer);
    }
}