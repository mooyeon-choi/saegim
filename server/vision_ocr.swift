import Foundation
import Vision
import ImageIO

// Line-oriented worker: one local image path in, one JSON result out.
while let line = readLine() {
    do {
        guard let data = line.data(using: .utf8),
              let input = try JSONSerialization.jsonObject(with: data) as? [String: String],
              let path = input["path"] else { throw NSError(domain: "Input", code: 1) }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["ko-KR", "en-US"]
        request.usesLanguageCorrection = false
        request.minimumTextHeight = 0.012
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
        try handler.perform([request])
        let rows: [[String: Any]] = (request.results ?? []).compactMap { observation in
            guard let best = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return ["text": best.string, "confidence": best.confidence,
                    "x": box.origin.x, "y": 1.0-box.origin.y-box.height,
                    "width": box.width, "height": box.height]
        }
        let result = try JSONSerialization.data(withJSONObject: ["results": rows], options: [.sortedKeys])
        print(String(decoding: result, as: UTF8.self))
    } catch {
        let result = try! JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])
        print(String(decoding: result, as: UTF8.self))
    }
    fflush(stdout)
}
